import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: the latter yields `/D:/a/...` on Windows,
// which node then resolves against the cwd drive as `D:\D:\a\...`.
const script = fileURLToPath(new URL('./add-plugin.mjs', import.meta.url));

/**
 * A ustar archive holding `entries`, gzipped.
 *
 * Written by hand rather than by a tar binary so the fixture is the same on
 * every machine; the reader is checked against real `npm pack` output
 * separately, which is what the format actually has to accept.
 */
function tarGz(entries) {
  const blocks = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** A plugin tarball: `dsh` is what the market keys on. */
function pluginTarball(name, version, { description = 'a plugin', dsh = { client: './dist/client.js' }, dependencies = {} } = {}) {
  return tarGz({
    'package/package.json': JSON.stringify({ name, version, description, dsh, dependencies, dist: { tarball: 'https://example.invalid/should-be-ignored.tgz' } }),
    'package/dist/client.js': 'export default 1\n',
  });
}

/** CRC32, as a zip requires; zlib.crc32 only exists on recent Node. */
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) === 0 ? value >>> 1 : 0xedb88320 ^ (value >>> 1);
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * A zip holding `entries`, in the layout Explorer and PowerShell produce.
 *
 * `entries` maps a path to its content, or to `{ data, mode, deflate }`. Store
 * and deflate are both exercised because a real zip uses whichever the archiver
 * felt like, and the reader has to handle both.
 */
function zipFile(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const spec = typeof value === 'string' || Buffer.isBuffer(value) ? { data: value } : value;
    const plain = Buffer.from(spec.data);
    const data = spec.deflate === true ? zlib.deflateRawSync(plain) : plain;
    const method = spec.deflate === true ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');
    const sum = crc32(plain);
    const time = 0;
    const date = (2026 - 1980) << 9 | (1 << 5) | 1;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(sum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(plain.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    // Unix mode lives in the high half of the external attributes; that is
    // where an execute bit survives.
    header.writeUInt32LE(((spec.mode ?? 0o644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, data);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** What a tarball actually holds: path, mode and size of every entry. */
function listTarball(tgz) {
  const tar = zlib.gunzipSync(tgz);
  const entries = [];
  let offset = 0;
  let pendingPath = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (buffer, start, length) => buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/su, '');
    const name = text(header, 0, 100);
    const prefix = text(header, 345, 155);
    const size = Number.parseInt(header.subarray(124, 136).toString('latin1').trim(), 8);
    const mode = Number.parseInt(header.subarray(100, 108).toString('latin1').trim(), 8);
    const type = String.fromCharCode(header[156]);
    const start = offset + 512;
    if (type === 'L') {
      // GNU long name: the path for the entry that follows. Kept out of the
      // listing on purpose — a reader that shows it as a file is broken.
      pendingPath = tar.subarray(start, start + size).toString('utf8').replace(/\0.*$/su, '');
    } else if (type === '0') {
      entries.push({ path: pendingPath ?? (prefix === '' ? name : `${prefix}/${name}`), mode, size });
      pendingPath = null;
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/** A snapshot shaped like the one build-bundle.mjs writes. */
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'njcb-add-plugin-'));
  await fs.mkdir(path.join(root, 'tarballs'));
  const snapshot = {
    selection: { plugins: { '@scope/existing': '1.0.0' } },
    artifacts: {},
    packages: {
      '@scope/existing': {
        name: '@scope/existing',
        'dist-tags': { latest: '1.0.0' },
        time: { '1.0.0': '2026-01-01T00:00:00.000Z' },
        versions: { '1.0.0': { name: '@scope/existing', version: '1.0.0', dsh: { client: './c.js' }, dist: { tarball: '/tarballs/existing.tgz' } } },
      },
    },
  };
  await fs.writeFile(path.join(root, 'registry.json'), JSON.stringify(snapshot));
  await fs.writeFile(path.join(root, 'plugins.txt'), '@scope/existing@1.0.0\r\n');
  await fs.writeFile(path.join(root, 'SHA256SUMS.txt'), '');
  return root;
}

function run(root, args) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
}

async function registryOf(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'registry.json'), 'utf8'));
}

test('a plugin tarball becomes an installable entry, with its bytes', async () => {
  const root = await workspace();
  try {
    const bytes = pluginTarball('@scope/fresh', '1.0.1');
    const file = path.join(root, 'fresh.tgz');
    await fs.writeFile(file, bytes);
    const result = run(root, [file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\+ @scope\/fresh@1\.0\.1 {2}plugin/);

    const snapshot = await registryOf(root);
    const manifest = snapshot.packages['@scope/fresh'].versions['1.0.1'];
    // The artifact name is the one build-bundle.mjs would pick, so a bundle
    // rebuilt later replaces this file instead of adding a second copy.
    const artifact = `${createHash('sha256').update('@scope/fresh@1.0.1').digest('hex')}.tgz`;
    assert.equal(manifest.dist.tarball, `/tarballs/${artifact}`);
    assert.match(manifest.dist.integrity, /^sha512-/u);
    assert.match(manifest.dist.shasum, /^[0-9a-f]{40}$/u);
    // A dist.tarball upstream reference must not survive: it would send the
    // client to a host this network does not have.
    assert.doesNotMatch(JSON.stringify(manifest.dist), /example\.invalid/u);

    assert.equal(snapshot.artifacts[artifact].source, 'upload:fresh.tgz');
    assert.equal(snapshot.artifacts[artifact].bytes, bytes.length);
    assert.deepEqual(await fs.readFile(path.join(root, 'tarballs', artifact)), bytes);

    assert.equal(snapshot.packages['@scope/fresh']['dist-tags'].latest, '1.0.1');
    assert.equal(snapshot.selection.plugins['@scope/fresh'], '1.0.1');
    assert.ok(snapshot.packages['@scope/fresh'].time['1.0.1']);

    // Both index files a person reads are rebuilt, not appended to.
    const sums = await fs.readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8');
    assert.match(sums, new RegExp(`${snapshot.artifacts[artifact].sha256}  tarballs/${artifact}`, 'u'));
    const list = await fs.readFile(path.join(root, 'plugins.txt'), 'utf8');
    assert.ok(list.includes('@scope/existing@1.0.0\r\n'));
    assert.ok(list.includes('@scope/fresh@1.0.1\r\n'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('adding the same bytes twice changes nothing and is not an error', async () => {
  const root = await workspace();
  try {
    const file = path.join(root, 'fresh.tgz');
    await fs.writeFile(file, pluginTarball('@scope/fresh', '1.0.1'));
    assert.equal(run(root, [file]).status, 0);
    const before = await fs.readFile(path.join(root, 'registry.json'), 'utf8');
    const second = run(root, [file]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /= @scope\/fresh@1\.0\.1  already in the snapshot/u);
    assert.equal(await fs.readFile(path.join(root, 'registry.json'), 'utf8'), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a published version cannot be rewritten without --force', async () => {
  const root = await workspace();
  try {
    const file = path.join(root, 'fresh.tgz');
    await fs.writeFile(file, pluginTarball('@scope/fresh', '1.0.1'));
    assert.equal(run(root, [file]).status, 0);

    const tampered = path.join(root, 'tampered.tgz');
    await fs.writeFile(tampered, pluginTarball('@scope/fresh', '1.0.1', { description: 'built somewhere else' }));
    const before = await fs.readFile(path.join(root, 'registry.json'), 'utf8');
    const refused = run(root, [tampered]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already in the snapshot with different bytes/u);
    assert.match(refused.stderr, /--force/u);
    assert.equal(await fs.readFile(path.join(root, 'registry.json'), 'utf8'), before);

    const forced = run(root, [tampered, '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /replaced/u);
    const snapshot = await registryOf(root);
    const artifact = `${createHash('sha256').update('@scope/fresh@1.0.1').digest('hex')}.tgz`;
    assert.equal(snapshot.packages['@scope/fresh'].versions['1.0.1'].description, 'built somewhere else');
    assert.equal(snapshot.artifacts[artifact].sha256, createHash('sha256').update(await fs.readFile(tampered)).digest('hex'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a dependency is storable but is never listed as installable', async () => {
  const root = await workspace();
  try {
    const file = path.join(root, 'left-pad.tgz');
    await fs.writeFile(file, tarGz({
      'package/package.json': JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
      'package/index.js': 'module.exports = 1\n',
    }));
    const result = run(root, [file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\+ left-pad@1\.3\.0 {2}dependency/u);

    const snapshot = await registryOf(root);
    // Installable: the plugin that needs it resolves it from this registry.
    assert.equal(snapshot.packages['left-pad']['dist-tags'].latest, '1.3.0');
    // Not shoppable: /-/ping answers with this map.
    assert.equal(snapshot.selection.plugins['left-pad'], undefined);
    assert.doesNotMatch(await fs.readFile(path.join(root, 'plugins.txt'), 'utf8'), /left-pad/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an older version is added without taking over the installed one', async () => {
  const root = await workspace();
  try {
    const newer = path.join(root, 'newer.tgz');
    await fs.writeFile(newer, pluginTarball('@scope/fresh', '2.0.0'));
    assert.equal(run(root, [newer]).status, 0);

    const older = path.join(root, 'older.tgz');
    await fs.writeFile(older, pluginTarball('@scope/fresh', '1.9.0'));
    const result = run(root, [older]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /latest stays 2\.0\.0/u);
    let snapshot = await registryOf(root);
    assert.equal(snapshot.packages['@scope/fresh']['dist-tags'].latest, '2.0.0');
    assert.equal(snapshot.selection.plugins['@scope/fresh'], '2.0.0');
    assert.ok(snapshot.packages['@scope/fresh'].versions['1.9.0']);

    // A rollback is a decision, so it takes saying so.
    const pinned = run(root, [older, '--latest']);
    assert.equal(pinned.status, 0, pinned.stderr);
    snapshot = await registryOf(root);
    assert.equal(snapshot.packages['@scope/fresh']['dist-tags'].latest, '1.9.0');
    assert.equal(snapshot.selection.plugins['@scope/fresh'], '1.9.0');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('missing dependencies are reported at upload time, not at first load', async () => {
  const root = await workspace();
  try {
    const file = path.join(root, 'plugin.tgz');
    await fs.writeFile(file, pluginTarball('@scope/fresh', '1.0.1', { dependencies: { 'left-pad': '^1.0.0', '@scope/existing': '^1.0.0' } }));
    const result = run(root, [file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 dependencies are not in this snapshot: left-pad/u);
    assert.doesNotMatch(result.stdout, /@scope\/existing/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a folder zipped in Explorer is repacked into an installable tarball', async () => {
  const root = await workspace();
  try {
    // The shape Explorer and Compress-Archive produce: one wrapper folder,
    // no `package/` root, deflate compression, an execute bit on the linker.
    const file = path.join(root, 'dsh-fresh-1.0.1.zip');
    await fs.writeFile(file, zipFile({
      'dsh-fresh/package.json': JSON.stringify({ name: '@scope/fresh', version: '1.0.1', dsh: { client: './lib/x.js' } }),
      'dsh-fresh/lib/x.js': { data: 'export default 1\n', deflate: true },
      'dsh-fresh/bin/cli.js': { data: '#!/usr/bin/env node\n', deflate: true, mode: 0o755 },
      // What a macOS zip puts beside the payload; it must not become a file in
      // the package, nor confuse the wrapper-folder detection.
      '__MACOSX/dsh-fresh/._package.json': 'junk',
    }));
    const result = run(root, [file]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\+ @scope\/fresh@1\.0\.1 {2}plugin/u);
    assert.match(result.stdout, /repacked from a \.zip, 3 files/u);

    const snapshot = await registryOf(root);
    const artifact = `${createHash('sha256').update('@scope/fresh@1.0.1').digest('hex')}.tgz`;
    assert.equal(snapshot.packages['@scope/fresh'].versions['1.0.1'].dist.tarball, `/tarballs/${artifact}`);
    // The hash describes what is stored, not what was dropped in.
    assert.equal(snapshot.artifacts[artifact].sha256, createHash('sha256').update(await fs.readFile(path.join(root, 'tarballs', artifact))).digest('hex'));

    const entries = listTarball(await fs.readFile(path.join(root, 'tarballs', artifact)));
    const paths = entries.map(entry => entry.path);
    assert.deepEqual(paths, ['package/package.json', 'package/lib/x.js', 'package/bin/cli.js']);
    // Execute bits are the one mode a zip carries that an install cares about.
    assert.equal(entries.find(entry => entry.path === 'package/bin/cli.js').mode, 0o755);
    assert.equal(entries.find(entry => entry.path === 'package/lib/x.js').mode, 0o644);
    assert.equal(entries.find(entry => entry.path === 'package/package.json').size, entries[0].size);
    assert.doesNotMatch(paths.join(' '), /dsh-fresh/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a zip of the folder contents, and one that already has package/, both land at package/', async () => {
  const root = await workspace();
  try {
    // No wrapper folder at all: the archive's entries are the plugin's files.
    const flat = path.join(root, 'flat.zip');
    await fs.writeFile(flat, zipFile({
      'package.json': JSON.stringify({ name: '@scope/flat', version: '1.0.0', dsh: {} }),
      'lib/x.js': 'export default 1\n',
    }));
    assert.equal(run(root, [flat]).status, 0);

    // Someone unzipped an npm tarball and zipped it back: the prefix is
    // already right and must not be doubled.
    const packed = path.join(root, 'packed.zip');
    await fs.writeFile(packed, zipFile({
      'package/package.json': JSON.stringify({ name: '@scope/packed', version: '1.0.0', dsh: {} }),
      'package/lib/x.js': 'export default 1\n',
    }));
    assert.equal(run(root, [packed]).status, 0);

    const snapshot = await registryOf(root);
    for (const name of ['@scope/flat', '@scope/packed']) {
      const artifact = `${createHash('sha256').update(`${name}@1.0.0`).digest('hex')}.tgz`;
      const paths = listTarball(await fs.readFile(path.join(root, 'tarballs', artifact))).map(entry => entry.path);
      assert.deepEqual(paths, ['package/package.json', 'package/lib/x.js'], name);
      assert.ok(snapshot.packages[name]);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a zip written with backslashes, as older Compress-Archive does, still lands at package/', async () => {
  const root = await workspace();
  try {
    const file = path.join(root, 'win.zip');
    await fs.writeFile(file, zipFile({
      'dsh-fresh\\package.json': JSON.stringify({ name: '@scope/win', version: '1.0.0', dsh: {} }),
      'dsh-fresh\\lib\\x.js': 'export default 1\n',
    }));
    const result = run(root, [file]);
    assert.equal(result.status, 0, result.stderr);
    const artifact = `${createHash('sha256').update('@scope/win@1.0.0').digest('hex')}.tgz`;
    assert.deepEqual(
      listTarball(await fs.readFile(path.join(root, 'tarballs', artifact))).map(entry => entry.path),
      ['package/package.json', 'package/lib/x.js'],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the same zip converted twice produces the same bytes', async () => {
  const root = await workspace();
  try {
    // The repack has to be deterministic — a tar header carrying "now" would
    // make every rebuild a different artifact, and the idempotency check
    // below would report a conflict for a file nobody changed.
    const file = path.join(root, 'plugin.zip');
    await fs.writeFile(file, zipFile({
      'plugin/package.json': JSON.stringify({ name: '@scope/fresh', version: '1.0.1', dsh: {} }),
      'plugin/lib/x.js': { data: 'export default 1\n', deflate: true },
    }));
    assert.equal(run(root, [file]).status, 0);
    const artifact = `${createHash('sha256').update('@scope/fresh@1.0.1').digest('hex')}.tgz`;
    const first = await fs.readFile(path.join(root, 'tarballs', artifact));
    const second = run(root, [file]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /= @scope\/fresh@1\.0\.1  already in the snapshot/u);
    assert.deepEqual(await fs.readFile(path.join(root, 'tarballs', artifact)), first);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('paths longer than a tar header are carried, not truncated', async () => {
  const root = await workspace();
  try {
    // Two lengths on purpose: 151 bytes still fits ustar's prefix field, 316
    // does not and has to go through a GNU long-name entry. Only the second
    // catches a header written without its typeflag.
    const medium = `lib/${'nested-directory-name/'.repeat(6)}file.js`;
    const long = `lib/${'very-long-directory-segment-name/'.repeat(9)}file.js`;
    assert.ok(Buffer.byteLength(`package/${medium}`) <= 255);
    assert.ok(Buffer.byteLength(`package/${long}`) > 255);

    const file = path.join(root, 'deep.zip');
    await fs.writeFile(file, zipFile({
      'plugin/package.json': JSON.stringify({ name: '@scope/deep', version: '1.0.0', dsh: {} }),
      [`plugin/${medium}`]: 'export default 1\n',
      [`plugin/${long}`]: 'export default 2\n',
    }));
    assert.equal(run(root, [file]).status, 0);

    const snapshot = await registryOf(root);
    const artifact = `${createHash('sha256').update('@scope/deep@1.0.0').digest('hex')}.tgz`;
    assert.ok(snapshot.artifacts[artifact]);
    const entries = listTarball(await fs.readFile(path.join(root, 'tarballs', artifact)));
    assert.deepEqual(entries.map(entry => entry.path), [
      'package/package.json',
      `package/${medium}`,
      `package/${long}`,
    ]);
    // The long-name marker is metadata; a reader that shows it as a file — or
    // that keeps the truncated 100-byte name — fails here.
    assert.ok(entries.every(entry => !entry.path.includes('@LongLink')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a zip is only refused when it is not a package at all', async () => {
  const root = await workspace();
  try {
    // A zip of the parent folder: package.json is one level down.
    const wrong = path.join(root, 'wrong.zip');
    await fs.writeFile(wrong, zipFile({ 'a.txt': 'x', 'lib/x.js': 'y' }));
    const refused = run(root, [wrong]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /has no package\.json at the top of the plugin folder/u);
    assert.match(refused.stderr, /a\.txt/u);

    // A tarball of a folder that was not packed: no package/ root.
    const flat = path.join(root, 'flat.tgz');
    await fs.writeFile(flat, tarGz({ 'package.json': JSON.stringify({ name: 'x', version: '1.0.0' }) }));
    const missing = run(root, [flat]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no package\/package\.json|not a package tarball/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a folder of uploads applies what it can and reports the file it could not', async () => {
  const root = await workspace();
  const uploads = path.join(root, 'uploads');
  try {
    await fs.mkdir(uploads);
    await fs.writeFile(path.join(uploads, 'a.good.tgz'), pluginTarball('@scope/good', '1.0.0'));
    await fs.writeFile(path.join(uploads, 'b.broken.tgz'), Buffer.from('this is not an archive'));
    await fs.writeFile(path.join(uploads, 'c.good.tgz'), pluginTarball('@scope/also-good', '0.1.0'));
    const result = run(root, [uploads]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /b\.broken\.tgz/u);
    assert.match(result.stdout, /added 2, replaced 0, unchanged 0, failed 1/u);
    const snapshot = await registryOf(root);
    assert.ok(snapshot.packages['@scope/good']);
    assert.ok(snapshot.packages['@scope/also-good']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('--dry-run reports the entry without writing anything', async () => {
  const root = await workspace();
  try {
    const file = path.join(root, 'fresh.tgz');
    await fs.writeFile(file, pluginTarball('@scope/fresh', '1.0.1'));
    const before = await fs.readFile(path.join(root, 'registry.json'), 'utf8');
    const result = run(root, [file, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /# @scope\/fresh@1\.0\.1/u);
    assert.match(result.stdout, /would add 1/u);
    assert.equal(await fs.readFile(path.join(root, 'registry.json'), 'utf8'), before);
    await assert.rejects(fs.access(path.join(root, 'tarballs', 'nothing')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the market sees a package published while the registry window is open', async () => {
  const root = await workspace();
  await fs.copyFile(fileURLToPath(new URL('./serve.mjs', import.meta.url)), path.join(root, 'serve.mjs'));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(root, 'serve.mjs')], {
    env: { ...process.env, NJCB_OFFLINE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`server exit ${code}`); })]);
    const base = `http://127.0.0.1:${port}`;
    const before = await (await fetch(`${base}/-/v1/search?text=&size=250`)).json();
    assert.equal(before.total, 1);

    const file = path.join(root, 'fresh.tgz');
    await fs.writeFile(file, pluginTarball('@scope/fresh', '1.0.1', { description: 'added while serving' }));
    const added = run(root, [file]);
    assert.equal(added.status, 0, added.stderr);

    // No restart: this is the promise the README makes to whoever drops a
    // tarball in and presses refresh.
    const after = await (await fetch(`${base}/-/v1/search?text=&size=250`)).json();
    assert.equal(after.total, 2);
    assert.deepEqual(after.objects.map(object => object.package.name).sort(), ['@scope/existing', '@scope/fresh']);
    const fresh = after.objects.find(object => object.package.name === '@scope/fresh').package;
    assert.equal(fresh.version, '1.0.1');
    assert.equal(fresh.description, 'added while serving');

    // And its bytes are downloadable at the URL the packument now advertises.
    const metadata = await (await fetch(`${base}/@scope%2ffresh`)).json();
    const tarball = await fetch(metadata.versions['1.0.1'].dist.tarball);
    assert.equal(tarball.status, 200);
    assert.deepEqual(Buffer.from(await tarball.arrayBuffer()), await fs.readFile(file));
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

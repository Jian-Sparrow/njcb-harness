#!/usr/bin/env node
// Publish a package into this offline snapshot, on the machine that has no
// network.
//
// serve.mjs is read-only by design: it answers from registry.json and
// tarballs/ and writes nothing, so there is no upload endpoint to POST to.
// The only way to add a plugin on the intranet side is therefore to put its
// bytes in tarballs/ and describe it in registry.json — which is what this
// does, from the archive the operator already has. Nothing is downloaded,
// unpacked to disk, or executed.
//
// Two containers are accepted. A .tgz from `npm pack` is stored as-is. A .zip
// is repacked into a tarball here, because the client strips one path
// component when it unpacks: a folder zipped on Windows has no `package/`
// root, so publishing it untouched would install an empty directory.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { topLevelManifest } from './tgz-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// npm's own rules, relaxed to case-insensitive: the URL a client asks for is
// derived from this string, so anything with a space, a slash in the wrong
// place or a leading dot has to be refused here rather than 404 later.
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/iu;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const BLOCK = 512;

const usage = `Add a package to this offline snapshot.

Usage:
  node add-plugin.mjs <archive> [more archives ...]
  node add-plugin.mjs <folder>              (every .tgz/.zip inside it)
  node add-plugin.mjs --list

Options:
  --root <dir>   snapshot folder (default: the folder holding this script)
  --latest       make this the version the market installs, even if older
  --force        replace an existing version whose bytes differ
  --dry-run      report what would change, write nothing
  -h, --help     this text

Input is either the .tgz \`npm pack\` produces, or a .zip of the plugin folder
— a zip is repacked into a tarball on the way in, because the client strips
one path component when it unpacks. Nothing is downloaded or executed.

No network is needed, and the registry window does not need a restart:
serve.mjs re-reads registry.json when the file changes, so the market lists
the new entry on the next refresh.`;

class UsageError extends Error {}

/** Bytes as a person reads them, in a column that stays put. */
function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Parse a package manifest, naming the archive when it is malformed. */
function parseManifest(bytes, file) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`package.json in ${path.basename(file)} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`package.json in ${path.basename(file)} is not an object`);
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Reading: a tarball is read, a zip is read and rewritten as a tarball        */
/* -------------------------------------------------------------------------- */

/** An octal header field, zero-padded to the width tar expects. */
function octalField(value, width) {
  const text = Math.max(0, Math.trunc(value)).toString(8).padStart(width - 1, '0');
  if (text.length > width - 1) throw new Error(`value ${value} does not fit a ${width}-byte tar field`);
  return `${text}\0`;
}

/** Padding to the next 512-byte boundary. */
function padding(size) {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/**
 * One ustar header block.
 *
 * The name is written to `prefix` when it does not fit the 100-byte name
 * field, which is how ustar carries paths up to 255 bytes; longer ones go
 * through a GNU `././@LongLink` entry that the caller writes first — and that
 * entry is only recognized because its typeflag is 'L', not '0'.
 */
function tarHeader({ name, prefix, size, mode, mtime, type = '0' }) {
  const block = Buffer.alloc(BLOCK);
  // Copied as bytes, not written as a string: a name cut mid-character is
  // exactly what GNU tar does here, and nobody reads it — the long-link entry
  // it accompanies carries the real path.
  Buffer.from(name, 'utf8').copy(block, 0, 0, 100);
  block.write(octalField(mode, 8), 100, 8, 'latin1');
  block.write(octalField(0, 8), 108, 8, 'latin1');
  block.write(octalField(0, 8), 116, 8, 'latin1');
  block.write(octalField(size, 12), 124, 12, 'latin1');
  block.write(octalField(mtime, 12), 136, 12, 'latin1');
  block.write('        ', 148, 8, 'latin1');
  block.write(type, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  if (prefix !== undefined) Buffer.from(prefix, 'utf8').copy(block, 345, 0, 155);
  const checksum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}

/** Split a long path into ustar prefix/name, or null when it cannot be. */
function ustarSplit(relative) {
  for (let index = relative.lastIndexOf('/'); index > 0; index = relative.lastIndexOf('/', index - 1)) {
    const name = relative.slice(index + 1);
    const prefix = relative.slice(0, index);
    if (Buffer.byteLength(name, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) return { name, prefix };
  }
  return null;
}

/**
 * A tarball holding `files` at `package/…`.
 *
 * Written rather than delegated because there is nothing to delegate to: no
 * tar binary is guaranteed on the machine that runs this, and the bundle ships
 * only Node.
 */
function packTarball(files) {
  const blocks = [];
  for (const file of files) {
    const nameBytes = Buffer.from(file.path, 'utf8');
    let name = file.path;
    let prefix;
    if (nameBytes.length > 100) {
      const split = ustarSplit(file.path);
      if (split !== null) {
        name = split.name;
        prefix = split.prefix;
      } else {
        // Past 255 bytes there is no ustar spelling; a GNU long name is what
        // npm's own tarballs use and what every client understands.
        const long = Buffer.concat([nameBytes, Buffer.from([0])]);
        blocks.push(tarHeader({ name: '././@LongLink', type: 'L', size: long.length, mode: 0o644, mtime: file.mtime }));
        blocks.push(long, padding(long.length));
      }
    }
    blocks.push(tarHeader({ name, prefix, size: file.data.length, mode: file.mode, mtime: file.mtime }));
    blocks.push(file.data, padding(file.data.length));
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Where the zip's central directory ends, or -1. */
function endOfCentralDirectory(zip) {
  // The record is at most 22 bytes plus a 65535-byte comment, so it cannot
  // start earlier than this.
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  for (let index = zip.length - 22; index >= floor; index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

/** A DOS date and time as epoch seconds, for a deterministic tar header. */
function dosTimestamp(date, time) {
  const year = 1980 + ((date >>> 9) & 0x7f);
  const month = (date >>> 5) & 0x0f;
  const day = date & 0x1f;
  if (month < 1 || month > 12 || day < 1) return 0;
  const stamp = Date.UTC(year, month - 1, day, (time >>> 11) & 0x1f, (time >>> 5) & 0x3f, (time & 0x1f) * 2) / 1000;
  return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Every file in a zip, decompressed.
 *
 * Read through the central directory rather than by walking local headers:
 * that is where the sizes live when an entry was streamed (the local header
 * then has zeros), so walking would misread exactly the archives Windows
 * produces.
 */
function unzip(zip) {
  const eocd = endOfCentralDirectory(zip);
  if (eocd === -1) throw new Error('this is not a readable ZIP archive (no end-of-central-directory record)');
  const count = zip.readUInt16LE(eocd + 10);
  const directory = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || directory === 0xffffffff) {
    throw new Error('this is a ZIP64 archive, which is not supported; repack it with `Compress-Archive` or `npm pack` without the >4 GB / 65535-file options');
  }
  const files = [];
  let cursor = directory;
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('this ZIP archive is damaged (bad central directory entry)');
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const time = zip.readUInt16LE(cursor + 12);
    const date = zip.readUInt16LE(cursor + 14);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const plainSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const external = zip.readUInt32LE(cursor + 38);
    const local = zip.readUInt32LE(cursor + 42);
    const rawName = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    // Backslashes are not legal in a zip entry name, but Windows PowerShell's
    // Compress-Archive has written them anyway, and a separator this tool
    // does not recognize makes every path look like one long file name.
    const name = rawName.toString('utf8').replace(/\\/gu, '/');
    cursor += 46 + nameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0) throw new Error(`${name} is encrypted; this snapshot cannot store a password-protected archive`);
    if (compressedSize === 0xffffffff || plainSize === 0xffffffff || local === 0xffffffff) {
      throw new Error(`${name} needs ZIP64, which is not supported; repack the plugin with \`npm pack\``);
    }
    // A name that does not decode is a name this tool would write into a
    // tarball as mojibake, and the client would then fail to find its files.
    if (name.includes('\ufffd')) {
      throw new Error(`${JSON.stringify(name)} is not UTF-8, so its file names cannot be translated; repack the folder with \`tar -czf\` or \`npm pack\`, or save the archive as UTF-8`);
    }
    if (name.endsWith('/')) continue;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`this ZIP archive is damaged (bad local header for ${name})`);
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const stored = zip.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = stored;
    else if (method === 8) data = zlib.inflateRawSync(stored);
    else throw new Error(`${name} uses ZIP compression method ${method}, which is not supported; repack it as a normal (deflate) zip, or with \`npm pack\``);
    if (data.length !== plainSize) throw new Error(`this ZIP archive is truncated (${name} is ${data.length} of ${plainSize} bytes)`);
    const mode = (external >>> 16) & 0o777;
    files.push({ name, data, mode, mtime: dosTimestamp(date, time) });
  }
  return files;
}

/** Files a zip carries that are not part of the package. */
function isArchiveNoise(name) {
  return name.startsWith('__MACOSX/') || name === '.DS_Store' || name.endsWith('/.DS_Store');
}

/**
 * A zip's files, rewritten to sit at `package/…`.
 *
 * A zip made by zipping a folder has one root directory and no `package/`
 * prefix; one made by zipping the folder's contents has neither. Both are
 * what an operator produces in Explorer, and both have to come out as the
 * layout npm expects.
 */
function zipPackageFiles(file, zip) {
  const files = unzip(zip).filter(entry => !isArchiveNoise(entry.name.replace(/^\.\//u, '')));
  if (files.length === 0) throw new Error(`${path.basename(file)} holds no files`);
  const names = files.map(entry => entry.name.replace(/^\.\//u, ''));
  const roots = new Set(names.map(name => name.split('/')[0]));
  // Only a single root can be the wrapper, and only when every entry is
  // inside it — a zip of the contents has several first segments and none of
  // them is a folder to drop.
  const strip = roots.size === 1 && names.every(name => name.includes('/')) ? [...roots][0] : null;
  const seen = new Set();
  return files.map((entry, index) => {
    // `names[index]` starts with the wrapper segment, so dropping it is a
    // slice, not a second guess at the path.
    const relative = strip === null ? names[index] : names[index].slice(strip.length + 1);
    const at = `package/${relative}`;
    if (seen.has(at)) throw new Error(`${path.basename(file)} has two entries that would both become ${at}`);
    seen.add(at);
    return {
      path: at,
      data: entry.data,
      // Execute bits are the only mode a zip carries that installs care
      // about; everything else is a file.
      mode: (entry.mode & 0o111) === 0 ? 0o644 : 0o755,
      mtime: entry.mtime,
    };
  });
}

/**
 * The archive's tarball bytes and its manifest.
 *
 * `container` says what came in, so the report can tell an operator that their
 * zip was rewritten instead of leaving them wondering why the stored bytes do
 * not match the file they dropped.
 */
function readPackage(file) {
  const raw = fs.readFileSync(file);
  if (raw.length === 0) throw new Error('the file is empty');

  if (raw[0] === 0x50 && raw[1] === 0x4b) {
    const files = zipPackageFiles(file, raw);
    const manifestAt = files.find(entry => entry.path === 'package/package.json');
    if (manifestAt === undefined) {
      const sample = files.slice(0, 4).map(entry => entry.path).join(', ');
      throw new Error(
        `${path.basename(file)} has no package.json at the top of the plugin folder (it contains ${sample}`
        + `${files.length > 4 ? ', …' : ''}). Zip the folder that holds package.json, not its parent.`,
      );
    }
    // The manifest first: npm's own tarballs lead with it, and a packer that
    // streams the archive expects to see it before anything else.
    const ordered = [manifestAt, ...files.filter(entry => entry !== manifestAt)];
    return { bytes: packTarball(ordered), manifest: parseManifest(manifestAt.data, file), container: 'zip', files: ordered.length };
  }

  const gzipped = raw[0] === 0x1f && raw[1] === 0x8b;
  let tar = raw;
  if (gzipped) {
    try {
      tar = zlib.gunzipSync(raw);
    } catch (error) {
      throw new Error(`not a valid gzip archive: ${error.message}`);
    }
  }
  const manifestAt = topLevelManifest(tar);
  if (manifestAt === null) {
    throw new Error(
      'no package/package.json at the top of the archive, so this is not a package tarball — '
      + 'a folder zipped as-is has no `package/` root; `npm pack` produces one, and a .zip is accepted too',
    );
  }
  const manifest = parseManifest(manifestAt, file);
  // A plain .tar is stored as .tgz: every client expects gzip, and re-packing
  // an already-gzipped tarball is not done, so the stored bytes stay identical
  // to what `npm pack` emitted.
  return { bytes: gzipped ? raw : zlib.gzipSync(raw), manifest, container: gzipped ? 'tgz' : 'tar', files: null };
}

/** A version split into the parts that order it, or null when malformed. */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  };
}

/**
 * Order two versions the way semver does, and the way npm's dist-tags do not:
 * a release outranks any prerelease of the same core, so adding 1.0.0 next to
 * an installed 2.0.0-beta.1 must not silently move the tag forward.
 */
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const one = a.prerelease[index];
    const other = b.prerelease[index];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    if (one === other) continue;
    const oneNumeric = /^\d+$/u.test(one);
    const otherNumeric = /^\d+$/u.test(other);
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1;
    // Numeric identifiers sort below alphanumeric ones.
    if (oneNumeric) return -1;
    if (otherNumeric) return 1;
    return one < other ? -1 : 1;
  }
  return 0;
}

/** The artifact name build-bundle.mjs would have chosen, so both agree. */
function artifactName(name, version) {
  return `${createHash('sha256').update(`${name}@${version}`).digest('hex')}.tgz`;
}

function loadSnapshot(root) {
  const file = path.join(root, 'registry.json');
  if (!fs.existsSync(file)) {
    throw new UsageError(
      `no registry.json in ${root} — this folder is not an offline snapshot.\n`
      + 'Build one with build-bundle.mjs on a networked machine, then copy the whole folder here.',
    );
  }
  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`registry.json is not valid JSON: ${error.message}`);
  }
  if (snapshot.packages === null || typeof snapshot.packages !== 'object') throw new UsageError('registry.json has no packages map');
  // A snapshot built before self-description existed still has to accept a
  // package; the missing maps are what /-/ping and /tarballs read.
  snapshot.artifacts ??= {};
  snapshot.selection ??= {};
  snapshot.selection.plugins ??= {};
  return { file, snapshot };
}

/**
 * Write registry.json in one step.
 *
 * The registry window may be reading this file while it is being written, and
 * a half-written file would fail to parse on its next request. A rename
 * replaces the name atomically, so a reader sees the old file or the new one.
 */
function saveSnapshot(file, snapshot) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot));
  fs.renameSync(temporary, file);
}

/**
 * Add one tarball to the snapshot in memory, and its bytes to disk.
 *
 * Returns what happened rather than printing it: a batch of uploads has to
 * report every file it refused, not just stop at the first one.
 */
function addPackage(file, root, snapshot, options) {
  const { bytes, manifest, container, files } = readPackage(file);
  const name = manifest.name;
  const version = manifest.version;
  if (typeof name !== 'string' || name.length > 214 || !NAME.test(name)) {
    throw new Error(`package.json has an unusable name (${JSON.stringify(name)})`);
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`package.json has an unusable version (${JSON.stringify(version)})`);
  }

  const filename = artifactName(name, version);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pack = snapshot.packages[name];
  const published = pack?.versions?.[version];
  const existing = snapshot.artifacts[filename];

  // The same bytes added twice is a no-op: an operator who re-runs the batch
  // after a failure wants the rest of it applied, not an error about the file
  // that already made it. `--latest` still has to be honoured here, because
  // re-running the batch with it is how a version gets pinned back without
  // republishing anything.
  if (published !== undefined && existing !== undefined && existing.sha256 === sha256) {
    const record = snapshot.packages[name];
    const repointed = options.latest === true && record['dist-tags']?.latest !== version;
    if (repointed) {
      record['dist-tags'].latest = version;
      if (manifest.dsh !== undefined && manifest.dsh !== null) snapshot.selection.plugins[name] = version;
    }
    return { outcome: 'unchanged', name, version, filename, changed: repointed, repointed, container, files };
  }
  if (published !== undefined && !options.force) {
    throw new Error(
      `${name}@${version} is already in the snapshot with different bytes `
      + `(${existing?.sha256?.slice(0, 12) ?? 'unknown'} vs ${sha256.slice(0, 12)}). `
      + 'npm refuses to republish a version for the same reason: clients that cached the '
      + 'old one fail their integrity check. Publish a new version, or pass --force.',
    );
  }

  if (!options.dryRun) {
    fs.mkdirSync(path.join(root, 'tarballs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tarballs', filename), bytes);
    // Written from the bytes in hand rather than from the uploaded file, so a
    // file that changed between the two reads cannot produce a tarball whose
    // recorded hash is wrong.
    snapshot.artifacts[filename] = {
      name,
      version,
      sha256,
      bytes: bytes.length,
      // Provenance for the person debugging this in six months. The bundle's
      // own entries record the upstream URL; there is none for an upload.
      source: `upload:${path.basename(file)}`,
    };
  }

  const record = pack ?? { name, 'dist-tags': {}, versions: {}, time: {} };
  record.versions ??= {};
  record.time ??= {};
  record['dist-tags'] ??= {};
  record.versions[version] = {
    ...structuredClone(manifest),
    // Absolute from the server root; serve.mjs prefixes the origin on load,
    // exactly as it does for the packages build-bundle.mjs fetched.
    dist: {
      ...(manifest.dist ?? {}),
      tarball: `/tarballs/${filename}`,
      shasum: createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    },
  };
  record.time[version] = new Date().toISOString();
  snapshot.packages[name] = record;

  const current = record['dist-tags'].latest;
  const becomesLatest = current === undefined || options.latest || compareVersions(version, current) > 0;
  if (becomesLatest) record['dist-tags'].latest = version;

  const isPlugin = manifest.dsh !== undefined && manifest.dsh !== null;
  // /-/ping answers with this map, and it is the fallback a market uses when
  // the registry has no search endpoint. A dependency does not belong in a
  // list of things a person can install.
  if (isPlugin) snapshot.selection.plugins[name] = record['dist-tags'].latest;

  // A plugin whose dependencies are not in the snapshot installs and then
  // fails to load, on the intranet, with a message about a missing module.
  // Saying so at upload time is the only cheap moment to say it.
  const missing = isPlugin
    ? Object.keys(manifest.dependencies ?? {}).filter(dependency => snapshot.packages[dependency] === undefined)
    : [];

  return {
    outcome: published === undefined ? 'added' : 'replaced',
    name,
    version,
    filename,
    bytes: bytes.length,
    changed: true,
    container,
    files,
    isPlugin,
    becomesLatest,
    latest: record['dist-tags'].latest,
    missing,
  };
}

/** Recompute the two index files build-bundle.mjs also writes. */
function writeIndexes(root, snapshot) {
  const sums = Object.keys(snapshot.artifacts)
    .sort()
    .map(filename => `${snapshot.artifacts[filename].sha256}  tarballs/${filename}`)
    .join('\n');
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), `${sums}\n`);
  // The manual-install list: package name and version, Windows line endings
  // and a trailing one, because this file is pasted into a console there.
  const list = Object.entries(snapshot.selection.plugins).map(([name, version]) => `${name}@${version}`).join('\r\n');
  fs.writeFileSync(path.join(root, 'plugins.txt'), `${list}\r\n`);
}

function describeSnapshot(root, snapshot) {
  const names = Object.keys(snapshot.packages).sort();
  const rows = names.map(name => {
    const pack = snapshot.packages[name];
    const version = pack['dist-tags']?.latest;
    const manifest = pack.versions?.[version] ?? {};
    const isPlugin = manifest.dsh !== undefined && manifest.dsh !== null;
    const artifact = snapshot.artifacts[artifactName(name, version)];
    return { name, version, kind: isPlugin ? 'plugin' : 'dependency', bytes: artifact?.bytes ?? 0 };
  });
  const width = Math.max(0, ...rows.map(row => `${row.name}@${row.version}`.length));
  console.log(`${path.join(root, 'registry.json')}`);
  for (const row of rows) {
    console.log(`  ${`${row.name}@${row.version}`.padEnd(width)}  ${row.kind.padEnd(10)}  ${size(row.bytes)}`);
  }
  const plugins = rows.filter(row => row.kind === 'plugin').length;
  console.log(`${rows.length} packages: ${plugins} plugins, ${rows.length - plugins} dependencies, ${Object.keys(snapshot.artifacts).length} artifacts`);
}

function parseArgs(argv) {
  const options = { root: HERE, inputs: [], list: false, latest: false, force: false, dryRun: false, help: false };
  const queue = [...argv];
  while (queue.length > 0) {
    const arg = queue.shift();
    if (arg === '--root' || arg === '--dir') {
      const value = queue.shift();
      if (value === undefined) throw new UsageError(`${arg} wants a path`);
      // --dir is the drag-a-folder spelling; it takes the same expansion a
      // positional folder does, so one folder is all it needs to mean.
      if (arg === '--dir') {
        if (fs.existsSync(value) && fs.statSync(value).isDirectory()) options.inputs.push(path.resolve(value));
        else throw new UsageError(`--dir ${value} is not a folder`);
      } else {
        options.root = path.resolve(value);
      }
    } else if (arg === '--list') options.list = true;
    else if (arg === '--latest') options.latest = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg.startsWith('-')) throw new UsageError(`unknown option ${arg}`);
    else options.inputs.push(path.resolve(arg));
  }
  return options;
}

/** Every .tgz under a folder, so a batch of uploads is one command. */
function expand(inputs) {
  const files = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) throw new UsageError(`${input} does not exist`);
    if (!fs.statSync(input).isDirectory()) {
      files.push(input);
      continue;
    }
    const names = fs.readdirSync(input).filter(name => /\.(?:tgz|zip)$/iu.test(name)).sort();
    if (names.length === 0) throw new UsageError(`no .tgz or .zip files in ${input}`);
    files.push(...names.map(name => path.join(input, name)));
  }
  return files;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage);
    return 0;
  }
  const { file, snapshot } = loadSnapshot(options.root);
  if (options.list) {
    describeSnapshot(options.root, snapshot);
    return 0;
  }
  if (options.inputs.length === 0) throw new UsageError(`nothing to add\n\n${usage}`);

  const files = expand(options.inputs);
  const outcomes = [];
  const failures = [];
  for (const source of files) {
    try {
      const result = addPackage(source, options.root, snapshot, options);
      outcomes.push({ source, ...result });
    } catch (error) {
      // One bad file must not discard the rest: a folder of uploads almost
      // always contains the one nobody packed correctly.
      failures.push({ source, message: error.message });
    }
  }

  const changed = outcomes.filter(outcome => outcome.changed).length;
  if (!options.dryRun && changed > 0) {
    saveSnapshot(file, snapshot);
    writeIndexes(options.root, snapshot);
  }

  for (const outcome of outcomes) {
    const label = `${outcome.name}@${outcome.version}`;
    if (outcome.outcome === 'unchanged') {
      console.log(
        outcome.repointed
          ? `= ${label}  already in the snapshot; latest now points at it`
          : `= ${label}  already in the snapshot with these exact bytes`,
      );
      continue;
    }
    const notes = [];
    if (outcome.outcome === 'replaced') notes.push('replaced');
    if (outcome.container === 'zip') notes.push(`repacked from a .zip, ${outcome.files} files`);
    if (!outcome.becomesLatest) notes.push(`latest stays ${outcome.latest}; pass --latest to move it`);
    console.log(
      `${options.dryRun ? '#' : '+'} ${label}  ${outcome.isPlugin ? 'plugin' : 'dependency'}  ${size(outcome.bytes)}`
      + `${notes.length === 0 ? '' : `  (${notes.join('; ')})`}`,
    );
    if (outcome.missing.length > 0) {
      console.log(`  ! ${outcome.missing.length} dependencies are not in this snapshot: ${outcome.missing.join(', ')}`);
      console.log('    the plugin will install and then fail to load unless the host already provides them');
    }
  }
  for (const failure of failures) {
    console.error(`error: ${path.relative(process.cwd(), failure.source) || failure.source}: ${failure.message}`);
  }

  const added = outcomes.filter(outcome => outcome.outcome === 'added').length;
  const replaced = outcomes.filter(outcome => outcome.outcome === 'replaced').length;
  const unchanged = outcomes.filter(outcome => outcome.outcome === 'unchanged').length;
  const verb = options.dryRun ? 'would add' : 'added';
  console.log(
    `${verb} ${added}, replaced ${replaced}, unchanged ${unchanged}, failed ${failures.length}`
    + ` — ${Object.keys(snapshot.packages).length} packages in the snapshot`,
  );
  if (!options.dryRun && changed > 0) console.log('refresh the market page; the registry window re-reads registry.json on its own');
  return failures.length > 0 ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

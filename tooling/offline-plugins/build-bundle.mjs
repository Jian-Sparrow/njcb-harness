// Create a read-only npm snapshot from the committed resolution lock. Run in an
// online build environment.
//
// Nothing here resolves versions: `selection-lock.json` already did, once, on a
// machine that had the network, and it is reviewed and committed with the
// selection. A build that re-resolved on its own would drift — npm moves
// `latest` underneath a range without telling anyone, and two snapshots taken a
// week apart then disagree about transitive versions. The client keeps a pnpm
// lockfile of its own, so a snapshot that disagrees with it fails the whole
// install with `No matching version found for <dep>@<version>`: a message that
// names a package nobody chose.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expectedDependencies, lockDifferences, vendorEntries, VENDOR_DIR } from './selection-lock.mjs';
import { readArchiveManifest } from './tgz-manifest.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(argument => argument.startsWith('--')));
const positional = argv.filter(argument => !argument.startsWith('--'));
for (const flag of flags) {
  if (flag !== '--check' && flag !== '--update-lock') throw new Error(`unknown option ${flag}\n\nusage: node build-bundle.mjs [output-dir] [--check | --update-lock]`);
}
const output = path.resolve(positional[0] || 'offline-output');
const checkOnly = flags.has('--check');
const relock = flags.has('--update-lock');

const selection = JSON.parse(await fs.readFile(path.join(source, 'selection.json'), 'utf8'));
const lockFile = path.join(source, 'selection-lock.json');
const staging = path.join(output, 'resolution');
const expected = expectedDependencies(selection);
const vendored = vendorEntries(selection);

/** The parsed lock, or undefined when the file is not there yet. */
async function readLock() {
  const text = await fs.readFile(lockFile, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`selection-lock.json is not valid JSON: ${error.message}`);
  }
}

/** Copy every vendored archive where the lock names it. */
async function stageVendored() {
  await fs.mkdir(path.join(staging, VENDOR_DIR), { recursive: true });
  for (const entry of vendored) {
    await fs.copyFile(path.join(source, entry.relative), path.join(staging, VENDOR_DIR, path.basename(entry.relative)));
  }
}

function outOfSync() {
  return [
    'selection-lock.json is out of sync with selection.json:',
    ...lockDifferences(locked, expected).map(line => `  ${line}`),
    '',
    'Run `node build-bundle.mjs --update-lock`, review the version changes it introduces, and commit selection-lock.json together with the selection change.',
  ].join('\n');
}

/**
 * Resolve the selection into a fresh lock. Only `--update-lock` gets here: the
 * versions this picks are the ones every later build will ship, so the diff is
 * the thing to read before committing.
 */
async function resolveLock() {
  await stageVendored();
  await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'njcb-offline-plugins', version: '1.0.0', private: true, dependencies: expected }, null, 2));
  // npm is used only for dependency resolution, not for running third-party
  // lifecycle scripts.
  const install = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--package-lock-only', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' });
  if (install.status !== 0) throw new Error(`Dependency resolution failed: ${install.status}`);
  const resolved = JSON.parse(await fs.readFile(path.join(staging, 'package-lock.json'), 'utf8'));
  const differences = lockDifferences(resolved, expected);
  if (differences.length) throw new Error(`npm produced a lock that does not match selection.json:\n  ${differences.join('\n  ')}`);
  await fs.writeFile(lockFile, `${JSON.stringify(resolved, null, 2)}\n`);
  console.log(`wrote selection-lock.json (${Object.keys(resolved.packages).length - 1} packages) — review and commit it`);
  return resolved;
}

const locked = await readLock();
if (checkOnly) {
  if (locked === undefined) throw new Error('selection-lock.json is missing; run `node build-bundle.mjs --update-lock` once, on a machine with the network, and commit the result');
  if (lockDifferences(locked, expected).length) throw new Error(outOfSync());
  for (const entry of vendored) {
    const bytes = await fs.readFile(path.join(source, entry.relative)).catch(() => undefined);
    if (bytes === undefined) throw new Error(`selection.json vendors ${entry.name} from ${entry.relative}, which is not in this checkout`);
    const manifest = readArchiveManifest(bytes, entry.relative);
    if (manifest.name !== entry.name) throw new Error(`${entry.relative} contains ${manifest.name}, but selection.json vendors it as ${entry.name}`);
  }
  const registryCount = Object.keys(selection.plugins ?? {}).length;
  console.log(`lock ok: ${registryCount + vendored.length} packages (${registryCount} from the registry, ${vendored.length} vendored)`);
  process.exit(0);
}
if (locked === undefined && !relock) throw new Error('selection-lock.json is missing; run `node build-bundle.mjs --update-lock` once, on a machine with the network, and commit the result');
if (locked !== undefined && !relock && lockDifferences(locked, expected).length) throw new Error(outOfSync());
const lock = relock || locked === undefined ? await resolveLock() : locked;

await fs.mkdir(path.join(output, 'tarballs'), { recursive: true });
await stageVendored();

const requests = new Map();
const local = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || !entry.resolved) continue;
  const name = entry.name || location.slice(location.lastIndexOf('node_modules/') + 13);
  if (entry.resolved.startsWith('file:')) {
    local.push({ name, version: entry.version, file: path.join(staging, entry.resolved.slice(5)), integrity: entry.integrity });
    continue;
  }
  if (!entry.resolved.startsWith('https://registry.npmjs.org/')) throw new Error(`Non-registry dependency requires manual review: ${entry.resolved}`);
  requests.set(`${name}@${entry.version}`, { name, version: entry.version, integrity: entry.integrity });
}
async function get(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}
const registry = { packages: {}, artifacts: {}, selection, builtAt: new Date().toISOString() };
const packuments = new Map();
function packument(name) {
  if (!packuments.has(name)) packuments.set(name, get(`https://registry.npmjs.org/${encodeURIComponent(name)}`).then(bytes => JSON.parse(bytes)));
  return packuments.get(name);
}
/** One packument entry, created on first use and shared by every version. */
function packEntry(name) {
  return registry.packages[name] ||= { name, 'dist-tags': {}, versions: {}, time: {} };
}
const checksums = [];
const compatible = (values, target) => !values || (!values.includes(`!${target}`) && (!values.some(x => !x.startsWith('!')) || values.includes(target) || values.includes('any')));
// Locally built packages first: they are the reason the snapshot exists on a
// network that cannot reach their source, and their manifest carries the `dsh`
// field that decides whether the market lists them.
const vendorVersions = {};
for (const entry of local) {
  const bytes = await fs.readFile(entry.file);
  const manifest = readArchiveManifest(bytes, path.basename(entry.file));
  if (manifest.name !== entry.name || manifest.version !== entry.version) {
    throw new Error(`${path.basename(entry.file)} holds ${manifest.name}@${manifest.version}, but the lock records ${entry.name}@${entry.version}; re-pack it and run --update-lock`);
  }
  const filename = `${createHash('sha256').update(`${entry.name}@${entry.version}`).digest('hex')}.tgz`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // The lock recorded the archive's bytes. A re-packed tarball under the same
  // version would install as an integrity failure on the intranet, where nobody
  // can do anything about it — so the mismatch stops the build instead.
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (entry.integrity !== undefined && entry.integrity !== integrity) {
    throw new Error(`${path.basename(entry.file)} no longer matches the integrity recorded in selection-lock.json; re-pack it and run --update-lock`);
  }
  await fs.writeFile(path.join(output, 'tarballs', filename), bytes);
  registry.artifacts[filename] = { name: entry.name, version: entry.version, sha256, bytes: bytes.length, source: `vendored ${path.basename(entry.file)}` };
  checksums.push(`${sha256}  tarballs/${filename}`);
  manifest.dist = {
    ...manifest.dist,
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity,
    tarball: `/tarballs/${filename}`,
  };
  const pack = packEntry(entry.name);
  pack.versions[entry.version] = manifest;
  pack['dist-tags'].latest = entry.version;
  vendorVersions[entry.name] = entry.version;
  console.log(`vendored ${entry.name}@${entry.version}`);
}
const queue = [...requests.values()];
const downloaded = new Set();
let complete = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const { name, version, integrity } = queue.shift();
    const upstream = await packument(name);
    const manifest = structuredClone(upstream.versions[version]);
    if (manifest === undefined) throw new Error(`${name}@${version} is in selection-lock.json but the registry no longer serves it; re-run --update-lock`);
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Metadata mismatch: ${name}@${version}`);
    const filename = `${createHash('sha256').update(`${name}@${version}`).digest('hex')}.tgz`;
    const allowed = compatible(manifest.os, 'win32') && compatible(manifest.cpu, 'x64');
    if (allowed) {
      const data = await get(manifest.dist.tarball);
      const expectedIntegrity = integrity || manifest.dist.integrity;
      if (!expectedIntegrity) throw new Error(`No integrity: ${name}@${version}`);
      const [algorithm, value] = expectedIntegrity.split(' ')[0].split('-');
      if (createHash(algorithm).update(data).digest('base64') !== value) throw new Error(`Integrity mismatch: ${name}@${version}`);
      await fs.writeFile(path.join(output, 'tarballs', filename), data);
      const sha256 = createHash('sha256').update(data).digest('hex');
      registry.artifacts[filename] = { name, version, sha256, bytes: data.length, source: manifest.dist.tarball };
      checksums.push(`${sha256}  tarballs/${filename}`);
      downloaded.add(`${name}@${version}`);
    }
    manifest.dist = { ...manifest.dist, tarball: `/tarballs/${filename}` };
    // No upstream redirects are retained, including for platform-excluded optional artifacts.
    const pack = packEntry(name);
    pack.versions[version] = manifest;
    if (upstream.time?.[version]) pack.time[version] = upstream.time[version];
    pack['dist-tags'].latest = selection.plugins?.[name] || version;
    console.log(`${++complete}/${requests.size} ${name}@${version}${allowed ? '' : ' (metadata only: other OS/CPU)'}`);
  }
}));
// pnpm refuses the whole `add` when any dependency declares an install-time
// script it has not been told to trust (ERR_PNPM_IGNORED_BUILDS) — the intranet
// user ends up with nothing installed, not one plugin short, and the window is
// a console they cannot debug. Refuse here, where the build machine still has
// both a network and a shell.
const installScripts = [];
for (const [name, pack] of Object.entries(registry.packages)) {
  for (const [version, manifest] of Object.entries(pack.versions)) {
    if (!downloaded.has(`${name}@${version}`) && !Object.hasOwn(vendorVersions, name)) continue;
    const kinds = ['preinstall', 'install', 'postinstall'].filter(kind => manifest.scripts?.[kind]);
    if (kinds.length) installScripts.push(`${name}@${version} (${kinds.map(kind => `${kind}: ${manifest.scripts[kind]}`).join('; ')})`);
  }
}
if (installScripts.length) {
  throw new Error([
    'Refusing to build: these packages declare install-time scripts, and pnpm fails the entire offline install when it meets one it has not approved (ERR_PNPM_IGNORED_BUILDS):',
    ...installScripts.map(line => `  ${line}`),
    'Drop them from selection.json. Approving the build is not a fix on an intranet: the script usually reaches for a network the users do not have.',
  ].join('\n'));
}
// The shipped selection lists the vendored packages beside the registry ones:
// the client reads one list, and a package missing from it is a package
// `Install-plugins.cmd` will not install.
const shipped = { ...selection, plugins: { ...selection.plugins, ...vendorVersions } };
delete shipped.vendor;
registry.selection = shipped;
await fs.writeFile(path.join(output, 'registry.json'), JSON.stringify(registry));
await fs.writeFile(path.join(output, 'selection.json'), JSON.stringify(shipped, null, 2));
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.sort().join('\n') + '\n');
// add-plugin.mjs and its .cmd wrapper ship with the snapshot: the intranet
// side has no way to fetch them, and it is the side that needs to publish.
// INSTALL-GUIDE.zh-CN.md is deliberately untracked, so a build from a clean
// checkout does not have it; the copy is skipped rather than failing the build.
for (const file of ['serve.mjs', 'add-plugin.mjs', 'Add-plugin.cmd', 'Install-plugins.ps1', 'Clean-profile.ps1', 'Clean-profile.cmd', 'Start-offline-registry.cmd', 'Install-plugins.cmd', 'README.zh-CN.md', 'INSTALL-GUIDE.zh-CN.md', 'NJCB-Harness-安装指引.docx']) {
  const from = path.join(source, file);
  if (!(await fs.stat(from).catch(() => null))) {
    console.log(`skipped ${file} (not present in this checkout)`);
    continue;
  }
  await fs.copyFile(from, path.join(output, file));
}
await fs.writeFile(path.join(output, 'plugins.txt'), Object.entries(shipped.plugins).map(([n, v]) => `${n}@${v}`).join('\r\n') + '\r\n');
console.log(`Built ${Object.keys(registry.packages).length} packages, ${checksums.length} tarballs in ${output}`);

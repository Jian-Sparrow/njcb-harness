// Create a read-only npm snapshot from an npm lockfile. Run in an online build environment.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2] || 'offline-output');
const selection = JSON.parse(await fs.readFile(path.join(source, 'selection.json'), 'utf8'));
const staging = path.join(output, 'resolution');
await fs.mkdir(staging, { recursive: true });
await fs.mkdir(path.join(output, 'tarballs'), { recursive: true });
await fs.writeFile(path.join(staging, 'package.json'), JSON.stringify({ name: 'njcb-offline-plugins', version: '1.0.0', private: true, dependencies: selection.plugins }, null, 2));
// npm is used only for dependency resolution, not for running third-party lifecycle scripts.
const install = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--package-lock-only', '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/'], { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' });
if (install.status !== 0) throw new Error(`Dependency resolution failed: ${install.status}`);
const lock = JSON.parse(await fs.readFile(path.join(staging, 'package-lock.json'), 'utf8'));
const requests = new Map();
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || !entry.resolved) continue;
  if (!entry.resolved.startsWith('https://registry.npmjs.org/')) throw new Error(`Non-registry dependency requires manual review: ${entry.resolved}`);
  const name = entry.name || location.slice(location.lastIndexOf('node_modules/') + 13);
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
const checksums = [];
const compatible = (values, target) => !values || (!values.includes(`!${target}`) && (!values.some(x => !x.startsWith('!')) || values.includes(target) || values.includes('any')));
const queue = [...requests.values()];
let complete = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const { name, version, integrity } = queue.shift();
    const upstream = await packument(name);
    const manifest = structuredClone(upstream.versions[version]);
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Metadata mismatch: ${name}@${version}`);
    const filename = `${createHash('sha256').update(`${name}@${version}`).digest('hex')}.tgz`;
    const allowed = compatible(manifest.os, 'win32') && compatible(manifest.cpu, 'x64');
    if (allowed) {
      const data = await get(manifest.dist.tarball);
      const expected = integrity || manifest.dist.integrity;
      if (!expected) throw new Error(`No integrity: ${name}@${version}`);
      const [algorithm, value] = expected.split(' ')[0].split('-');
      if (createHash(algorithm).update(data).digest('base64') !== value) throw new Error(`Integrity mismatch: ${name}@${version}`);
      await fs.writeFile(path.join(output, 'tarballs', filename), data);
      const sha256 = createHash('sha256').update(data).digest('hex');
      registry.artifacts[filename] = { name, version, sha256, bytes: data.length, source: manifest.dist.tarball };
      checksums.push(`${sha256}  tarballs/${filename}`);
    }
    manifest.dist = { ...manifest.dist, tarball: `/tarballs/${filename}` };
    // No upstream redirects are retained, including for platform-excluded optional artifacts.
    const pack = registry.packages[name] ||= { name, 'dist-tags': {}, versions: {}, time: {} };
    pack.versions[version] = manifest;
    if (upstream.time?.[version]) pack.time[version] = upstream.time[version];
    pack['dist-tags'].latest = selection.plugins[name] || version;
    console.log(`${++complete}/${requests.size} ${name}@${version}${allowed ? '' : ' (metadata only: other OS/CPU)'}`);
  }
}));
await fs.writeFile(path.join(output, 'registry.json'), JSON.stringify(registry));
await fs.writeFile(path.join(output, 'selection.json'), JSON.stringify(selection, null, 2));
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.sort().join('\n') + '\n');
for (const file of ['serve.mjs', 'Install-plugins.ps1', 'Start-offline-registry.cmd', 'Install-plugins.cmd', 'README.zh-CN.md']) {
  await fs.copyFile(path.join(source, file), path.join(output, file));
}
await fs.writeFile(path.join(output, 'plugins.txt'), Object.entries(selection.plugins).map(([n, v]) => `${n}@${v}`).join('\r\n') + '\r\n');
console.log(`Built ${Object.keys(registry.packages).length} packages, ${checksums.length} tarballs in ${output}`);

// Download the reviewed Windows wheels and expose a PEP 503 simple index.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const output = path.resolve(process.argv[2] || 'offline-output');
const lock = JSON.parse(await fs.readFile(new URL('./python-lock.json', import.meta.url), 'utf8'));
const target = path.join(output, 'python');
await fs.mkdir(path.join(target, 'wheels'), { recursive: true });
const files = {};
const checksums = [];
const requirements = [];
for (const wheel of lock.wheels) {
  const response = await fetch(wheel.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${wheel.filename}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== wheel.sha256) throw new Error(`SHA256 mismatch: ${wheel.filename}`);
  const relative = `wheels/${wheel.filename}`;
  await fs.writeFile(path.join(target, relative), bytes);
  files[relative] = 'application/octet-stream';
  checksums.push(`${digest}  ${relative}`);
  requirements.push(`${wheel.name}==${wheel.version} --hash=sha256:${digest}`);
  const index = `simple/${wheel.name}/index.html`;
  await fs.mkdir(path.dirname(path.join(target, index)), { recursive: true });
  await fs.writeFile(path.join(target, index), `<!doctype html><html><body><a href="../../wheels/${wheel.filename}#sha256=${digest}">${wheel.filename}</a></body></html>\n`);
  files[index] = 'text/html; charset=utf-8';
  console.log(`Python: ${wheel.name}==${wheel.version}`);
}
await fs.writeFile(path.join(target, 'simple/index.html'), '<!doctype html><html><body>\n' + lock.wheels.map(w => `<a href="${w.name}/">${w.name}</a>`).join('\n') + '\n</body></html>\n');
files['simple/index.html'] = 'text/html; charset=utf-8';
await fs.writeFile(path.join(target, 'files.json'), JSON.stringify(files, null, 2) + '\n');
await fs.writeFile(path.join(target, 'requirements.txt'), requirements.join('\n') + '\n');
await fs.writeFile(path.join(target, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
await fs.writeFile(path.join(target, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
for (const file of ['Install-python.cmd', 'Install-python.ps1', 'Python.cmd', 'python-smoke.py']) {
  await fs.copyFile(new URL(`./${file}`, import.meta.url), path.join(output, file));
}

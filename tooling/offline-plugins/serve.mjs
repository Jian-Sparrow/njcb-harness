// Loopback-only, read-only npm snapshot. No upstream requests, installation, or writes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
const port = Number(process.env.NJCB_OFFLINE_PORT || 4873);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid NJCB_OFFLINE_PORT');
const base = `http://127.0.0.1:${port}`;
for (const pack of Object.values(data.packages)) {
  for (const manifest of Object.values(pack.versions)) manifest.dist.tarball = base + manifest.dist.tarball;
}
const server = http.createServer((req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, { error: 'Read-only offline snapshot' });
  let requested;
  try { requested = decodeURIComponent(new URL(req.url, base).pathname).replace(/^\//, ''); }
  catch { return reply(400, { error: 'Invalid URL' }); }
  if (requested === '' || requested === '-/ping') return reply(200, { service: 'njcb-offline-plugins', selection: data.selection });
  if (requested.startsWith('tarballs/')) {
    const filename = requested.slice(9);
    const entry = Object.hasOwn(data.artifacts, filename) ? data.artifacts[filename] : undefined;
    if (!entry) return reply(404, { error: 'Artifact not present for Windows x64' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': entry.bytes });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(path.join(root, 'tarballs', filename));
    stream.on('error', error => res.destroy(error));
    stream.pipe(res);
    return;
  }
  if (Object.hasOwn(data.packages, requested)) return reply(200, data.packages[requested]);
  const slash = requested.lastIndexOf('/');
  const packageName = requested.slice(0, slash);
  const pack = Object.hasOwn(data.packages, packageName) ? data.packages[packageName] : undefined;
  const version = requested.slice(slash + 1);
  if (pack && (Object.hasOwn(pack.versions, version) || Object.hasOwn(pack['dist-tags'], version))) return reply(200, pack.versions[pack['dist-tags'][version] || version]);
  console.error(`NOT IN SNAPSHOT: ${req.method} ${requested}`);
  return reply(404, { error: 'Package/version not included in this offline snapshot' });
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`NJCB offline registry: ${base}/\nKeep this window open while installing plugins. Ctrl+C to stop.`));

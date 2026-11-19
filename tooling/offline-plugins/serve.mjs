// Loopback-only, read-only npm snapshot. No upstream requests, installation, or writes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const registryFile = path.join(root, 'registry.json');
const port = Number(process.env.NJCB_OFFLINE_PORT || 4873);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid NJCB_OFFLINE_PORT');
const base = `http://127.0.0.1:${port}`;

// The snapshot can change while this window is open: add-plugin.mjs publishes
// into registry.json and tarballs/ from this same folder. Restarting a console
// to pick up one tarball is the step that gets skipped, and a stale listing
// then reads as "the upload failed" — so the file is re-read when its stamp
// moves, and not one request sooner. The stamp is mtime and size because a
// rewrite replaces the file, and both change with it.
let data = null;
let loaded = '';
function snapshot() {
  const stat = fs.statSync(registryFile);
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (data !== null && stamp === loaded) return data;
  const fresh = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  // Rewritten on every load, never in place on disk: the recorded tarball is
  // a path from the server root, and resolving it here is the one place that
  // knows the origin.
  for (const pack of Object.values(fresh.packages)) {
    for (const manifest of Object.values(pack.versions)) manifest.dist.tarball = base + manifest.dist.tarball;
  }
  data = fresh;
  loaded = stamp;
  return data;
}
snapshot();

// Which packages are DSH plugins.
//
// The snapshot also carries every plugin's dependency tree, so a listing that
// returned the registry as-is would bury the thirteen installable entries under
// a few hundred libraries. DSH plugins declare a `dsh` field in package.json and
// ordinary libraries do not, so that is the test — not keywords, which several
// plugins leave empty.
const latestOf = pack => pack.versions[pack['dist-tags']?.latest ?? Object.keys(pack.versions).at(-1)];
const isPlugin = pack => {
  const manifest = latestOf(pack);
  return manifest !== undefined && manifest.dsh !== undefined && manifest.dsh !== null;
};
const describe = (name, pack) => {
  const manifest = latestOf(pack);
  return {
    name,
    version: manifest.version,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
    date: pack.time?.[manifest.version],
    dsh: isPlugin(pack),
  };
};

const server = http.createServer((req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, { error: 'Read-only offline snapshot' });
  data = snapshot();
  let url, requested;
  try { url = new URL(req.url, base); requested = decodeURIComponent(url.pathname).replace(/^\//, ''); }
  catch { return reply(400, { error: 'Invalid URL' }); }
  if (requested === '' || requested === '-/ping') return reply(200, { service: 'njcb-offline-plugins', selection: data.selection });
  // npm's search API, which is how a client discovers what an unfamiliar
  // registry holds. Only the packages that are plugins are described here:
  // the point of this endpoint is to answer "what can I install from you",
  // and a dependency is not an answer to that. `/-/all` still lists
  // everything, for tools that want the whole snapshot.
  if (requested === '-/v1/search') {
    const text = (url.searchParams.get('text') || '').trim().toLowerCase();
    const size = Math.min(Number(url.searchParams.get('size') || 250) || 250, 1000);
    const from = Math.max(Number(url.searchParams.get('from') || 0) || 0, 0);
    const matched = Object.keys(data.packages)
      .filter(name => isPlugin(data.packages[name]))
      .map(name => describe(name, data.packages[name]))
      .filter(entry => text === '' || entry.name.toLowerCase().includes(text) || entry.description.toLowerCase().includes(text) || entry.keywords.some(word => String(word).toLowerCase().includes(text)));
    return reply(200, {
      objects: matched.slice(from, from + size).map(entry => ({ package: entry, score: { final: 1, detail: { quality: 1, popularity: 0, maintenance: 1 } }, searchScore: 1 })),
      total: matched.length,
      time: new Date().toUTCString(),
    });
  }
  // The pre-search spelling of the same question. Everything, dependencies
  // included — this one is the snapshot, not the shop window.
  if (requested === '-/all') {
    const all = {};
    for (const [name, pack] of Object.entries(data.packages)) {
      const latest = latestOf(pack);
      all[name] = { name, 'dist-tags': pack['dist-tags'] ?? {}, versions: { [latest.version]: latest } };
    }
    return reply(200, all);
  }
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

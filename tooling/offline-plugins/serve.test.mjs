import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** A snapshot with one plugin (carries `dsh`) and one plain dependency. */
const snapshot = {
  selection: { plugins: { '@scope/plugin': '1.0.0' } },
  artifacts: { 'test.tgz': { bytes: 7 } },
  packages: {
    '@scope/plugin': {
      name: '@scope/plugin',
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': '2026-01-02T03:04:05.000Z' },
      versions: { '1.0.0': { name: '@scope/plugin', version: '1.0.0', description: 'a plugin', keywords: ['dsh-plugin'], dsh: { bundle: { patch: './cordis.patch.yml' } }, dist: { tarball: '/tarballs/test.tgz' } } },
    },
    'left-pad': {
      name: 'left-pad',
      'dist-tags': { latest: '1.3.0' },
      versions: { '1.3.0': { name: 'left-pad', version: '1.3.0', description: 'a library', dist: { tarball: '/tarballs/test.tgz' } } },
    },
  },
};

/** Start the snapshot server over `snapshot` in a temporary directory. */
async function serve() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'njcb-registry-test-'));
  await fs.copyFile(new URL('./serve.mjs', import.meta.url), path.join(root, 'serve.mjs'));
  await fs.mkdir(path.join(root, 'tarballs'));
  await fs.writeFile(path.join(root, 'tarballs', 'test.tgz'), 'fixture');
  await fs.writeFile(path.join(root, 'registry.json'), JSON.stringify(snapshot));
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(root, 'serve.mjs')], { env: { ...process.env, NJCB_OFFLINE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`Server exit ${code}`) })]);
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('offline registry serves scoped metadata and local bytes, refuses writes and unknown paths', async () => {
  const server = await serve();
  const base = server.base;
  try {
    const metadata = await (await fetch(base + '/@scope%2fplugin')).json();
    assert.equal(metadata.versions['1.0.0'].dist.tarball, base + '/tarballs/test.tgz');
    assert.equal(await (await fetch(metadata.versions['1.0.0'].dist.tarball)).text(), 'fixture');
    assert.equal((await fetch(base + '/@scope/plugin/1.0.0')).status, 200);
    assert.equal((await fetch(base + '/unknown')).status, 404);
    assert.equal((await fetch(base + '/__proto__/test')).status, 404);
    assert.equal((await fetch(base + '/tarballs/..%2fregistry.json')).status, 404);
    assert.equal((await fetch(base + '/@scope/plugin', { method: 'PUT', body: '{}' })).status, 405);
  } finally {
    await server.close();
  }
});

test('the listing endpoints describe plugins, not the dependency tree', async () => {
  const server = await serve();
  const base = server.base;
  try {
    // Search is what a market asks to find out what it can install: plugins
    // only, with the fields an entry needs, and the version it would install.
    const search = await (await fetch(base + '/-/v1/search?text=&size=250')).json();
    assert.equal(search.total, 1);
    assert.equal(search.objects.length, 1);
    const found = search.objects[0].package;
    assert.equal(found.name, '@scope/plugin');
    assert.equal(found.version, '1.0.0');
    assert.equal(found.description, 'a plugin');
    assert.equal(found.dsh, true);
    assert.equal(found.date, '2026-01-02T03:04:05.000Z');

    // Text narrows it, and a dependency is never an answer.
    assert.equal((await (await fetch(base + '/-/v1/search?text=plugin')).json()).total, 1);
    assert.equal((await (await fetch(base + '/-/v1/search?text=left-pad')).json()).total, 0);

    // /-/all is the whole snapshot, dependencies included, for tools that
    // want to enumerate rather than shop.
    const all = await (await fetch(base + '/-/all')).json();
    assert.deepEqual(Object.keys(all).sort(), ['@scope/plugin', 'left-pad']);
    assert.equal(all['left-pad'].versions['1.3.0'].name, 'left-pad');
  } finally {
    await server.close();
  }
});

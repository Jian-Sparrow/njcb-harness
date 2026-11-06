import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('offline registry serves scoped metadata and local bytes, refuses writes and unknown paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'njcb-registry-test-'));
  let child;
  try {
    await fs.copyFile(new URL('./serve.mjs', import.meta.url), path.join(root, 'serve.mjs'));
    await fs.mkdir(path.join(root, 'tarballs'));
    await fs.writeFile(path.join(root, 'tarballs', 'test.tgz'), 'fixture');
    await fs.writeFile(path.join(root, 'registry.json'), JSON.stringify({selection:{plugins:{}},artifacts:{'test.tgz':{bytes:7}},packages:{'@scope/plugin':{name:'@scope/plugin','dist-tags':{latest:'1.0.0'},versions:{'1.0.0':{name:'@scope/plugin',version:'1.0.0',dist:{tarball:'/tarballs/test.tgz'}}}}}}));
    const port = 40000 + Math.floor(Math.random() * 10000);
    child = spawn(process.execPath, [path.join(root, 'serve.mjs')], { env: {...process.env,NJCB_OFFLINE_PORT:String(port)}, stdio:['ignore','pipe','pipe'] });
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(([code])=>{throw new Error(`Server exit ${code}`)})]);
    const base = `http://127.0.0.1:${port}`;
    const metadata = await (await fetch(base+'/@scope%2fplugin')).json();
    assert.equal(metadata.versions['1.0.0'].dist.tarball, base+'/tarballs/test.tgz');
    assert.equal(await (await fetch(metadata.versions['1.0.0'].dist.tarball)).text(), 'fixture');
    assert.equal((await fetch(base+'/@scope/plugin/1.0.0')).status,200);
    assert.equal((await fetch(base+'/unknown')).status,404);
    assert.equal((await fetch(base+'/__proto__/test')).status,404);
    assert.equal((await fetch(base+'/tarballs/..%2fregistry.json')).status,404);
    assert.equal((await fetch(base+'/@scope/plugin',{method:'PUT',body:'{}'})).status,405);
  } finally {
    if (child && child.exitCode === null) { child.kill(); await once(child,'exit'); }
    await fs.rm(root,{recursive:true,force:true});
  }
});

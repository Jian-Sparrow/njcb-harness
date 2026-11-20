import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = relative => readFileSync(new URL(relative, root), 'utf8');

test('offline plugins target the same runtime and installer as the Windows build', () => {
  const product = JSON.parse(read('package.json'));
  const desktop = JSON.parse(read('apps/desktop/package.json'));
  const selection = JSON.parse(read('tooling/offline-plugins/selection.json'));
  const workflow = read('.github/workflows/njcb-windows.yml');
  const buildVersion = workflow.match(/^\s+BUILD_VERSION: (\S+)$/m)?.[1];
  assert.equal(desktop.version, product.version);
  assert.equal(selection.runtime, product.version);
  assert.equal(selection.installer, buildVersion);
  assert.ok(buildVersion.startsWith(`${product.version}.`));
});

async function resolveInstaller(runId, run) {
  const workflow = read('.github/workflows/njcb-offline-plugins.yml');
  const script = workflow.match(/          script: \|\n((?:            .*\n)+)/)?.[1];
  assert.ok(script, 'Installer resolver script must exist');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('github', 'context', 'core', 'process', script);
  const outputs = {};
  await execute(
    { rest: { actions: { getWorkflowRun: async request => {
      assert.deepEqual(request, { owner: 'Jian-Sparrow', repo: 'njcb-harness', run_id: Number(runId) });
      return { data: run };
    } } } },
    { repo: { owner: 'Jian-Sparrow', repo: 'njcb-harness' } },
    { setOutput: (key, value) => { outputs[key] = value; } },
    { env: { INSTALLER_RUN_ID: runId } },
  );
  return outputs;
}

const successfulRun = {
  path: '.github/workflows/njcb-windows.yml',
  head_branch: 'njcb-main',
  conclusion: 'success',
  head_repository: { full_name: 'Jian-Sparrow/njcb-harness' },
  head_sha: 'abc123',
};

test('offline validation selects the successful installer build source commit', async () => {
  assert.deepEqual(await resolveInstaller('123', successfulRun), { run_id: '123', sha: 'abc123' });
});

test('offline validation rejects missing or malformed installer run IDs', async () => {
  for (const runId of [undefined, '', '0', '-1', '123abc']) {
    await assert.rejects(resolveInstaller(runId, successfulRun), /installer run ID is required/);
  }
});

test('offline validation rejects unsuccessful, unrelated, and foreign installer builds', async () => {
  for (const override of [
    { path: '.github/workflows/other.yml' },
    { head_branch: 'other' },
    { conclusion: 'failure' },
    { conclusion: null },
    { head_repository: { full_name: 'other/njcb-harness' } },
    { head_repository: null },
  ]) {
    await assert.rejects(resolveInstaller('123', { ...successfulRun, ...override }), /Select a successful njcb-main/);
  }
});

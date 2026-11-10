// The lock comparison is the gate that keeps a rebuild from silently shipping
// different transitive versions, so it is tested directly rather than through a
// build: a build needs the network and half a gigabyte of tarballs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedDependencies, lockDifferences, vendorEntries } from './selection-lock.mjs';

const selection = {
  plugins: { 'dsh-ppt': '0.20.5', 'dsh-ops': '0.4.1' },
  vendor: { dshmarket: 'vendor/dshmarket-1.73.18-intra.1.tgz' },
};

test('a vendored package becomes a file dependency beside the registry ones', () => {
  assert.deepEqual(expectedDependencies(selection), {
    'dsh-ppt': '0.20.5',
    'dsh-ops': '0.4.1',
    dshmarket: 'file:vendor/dshmarket-1.73.18-intra.1.tgz',
  });
});

test('the vendor spec keeps only the file name, wherever the archive is checked in', () => {
  assert.deepEqual(vendorEntries({ vendor: { dshmarket: 'some/other/dir/dshmarket.tgz' } }), [
    { name: 'dshmarket', relative: 'some/other/dir/dshmarket.tgz', spec: 'file:vendor/dshmarket.tgz' },
  ]);
});

test('a missing vendor section is not an error', () => {
  assert.deepEqual(vendorEntries({ plugins: { 'dsh-ppt': '0.20.5' } }), []);
});

test('one name cannot be both a registry plugin and a local build', () => {
  assert.throws(
    () => vendorEntries({ plugins: { dshmarket: '1.73.17' }, vendor: { dshmarket: 'vendor/dshmarket.tgz' } }),
    /names dshmarket twice/u,
  );
});

test('two vendored archives cannot share a file name', () => {
  assert.throws(
    () => vendorEntries({ vendor: { a: 'one/plugin.tgz', b: 'two/plugin.tgz' } }),
    /two archives named plugin\.tgz/u,
  );
});

test('a matching lock has nothing to report', () => {
  const lock = { packages: { '': { dependencies: { ...expectedDependencies(selection) } } } };
  assert.deepEqual(lockDifferences(lock, expectedDependencies(selection)), []);
});

test('every kind of drift is named, including a version change and a dropped plugin', () => {
  const expected = expectedDependencies(selection);
  const lock = {
    packages: {
      '': {
        dependencies: {
          'dsh-ppt': '0.20.4',
          dshmarket: 'file:vendor/dshmarket-1.73.18-intra.1.tgz',
          'dsh-old': '1.0.0',
        },
      },
    },
  };
  assert.deepEqual(lockDifferences(lock, expected), [
    'dsh-old: in the lock but no longer selected',
    'dsh-ops: missing from the lock (selection.json wants 0.4.1)',
    'dsh-ppt: lock has 0.20.4, selection.json wants 0.20.5',
  ]);
});

test('a lock without a root entry is reported, not thrown on', () => {
  assert.deepEqual(lockDifferences({}, { 'dsh-ppt': '0.20.5' }), [
    'selection-lock.json has no root package entry; regenerate it with --update-lock',
  ]);
});

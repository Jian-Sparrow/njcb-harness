// What the committed resolution lock must say, derived from selection.json.
//
// `build-bundle.mjs` resolves nothing when a lock exists: the lock IS the
// resolution, so that every build of the same selection carries the same
// transitive versions. That only holds while the lock still describes the
// selection, so the comparison lives here — away from the build — where it can
// be tested and where `--check` can run it without touching the network.
import path from 'node:path';

/** Where locally built packages wait to be packed: next to this script. */
export const VENDOR_DIR = 'vendor';

/**
 * The locally built packages selection.json adds, as `file:` dependencies.
 *
 * A fork of a plugin cannot come from the public registry — the published copy
 * is somebody else's build — so its tarball is committed beside this script and
 * named in the lock like any other dependency. The spec keeps only the file
 * name: the build copies every vendored archive into one `vendor/` directory
 * inside the resolution project, which is what npm records.
 * @param selection - the parsed selection.json.
 * @returns one entry per vendored package, in selection order.
 * @throws {Error} when a name is both a registry plugin and a vendored file.
 */
export function vendorEntries(selection) {
  const vendor = selection.vendor ?? {};
  const plugins = selection.plugins ?? {};
  const entries = [];
  const seen = new Set();
  for (const [name, relative] of Object.entries(vendor)) {
    if (Object.hasOwn(plugins, name)) {
      throw new Error(`selection.json names ${name} twice: remove it from "plugins" (the registry entry) or from "vendor" (the local build), not both`);
    }
    const file = path.basename(relative);
    if (seen.has(file)) throw new Error(`selection.json vendors two archives named ${file}; give them distinct names`);
    seen.add(file);
    entries.push({ name, relative, spec: `file:${VENDOR_DIR}/${file}` });
  }
  return entries;
}

/**
 * The root `dependencies` the lock must carry: registry plugins by version,
 * vendored ones by file.
 * @param selection - the parsed selection.json.
 * @returns a name-to-spec map.
 */
export function expectedDependencies(selection) {
  const dependencies = { ...selection.plugins };
  for (const entry of vendorEntries(selection)) dependencies[entry.name] = entry.spec;
  return dependencies;
}

/**
 * Every way the lock disagrees with the selection, as sentences a person can
 * act on. Empty means the lock is current.
 * @param lock - the parsed package-lock.json.
 * @param expected - {@link expectedDependencies} for the same selection.
 * @returns the differences, already sorted for stable output.
 */
export function lockDifferences(lock, expected) {
  const root = lock?.packages?.[''];
  if (root === undefined || typeof root !== 'object') {
    return ['selection-lock.json has no root package entry; regenerate it with --update-lock'];
  }
  const actual = root.dependencies ?? {};
  const lines = [];
  for (const [name, spec] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, name)) lines.push(`${name}: missing from the lock (selection.json wants ${spec})`);
    else if (actual[name] !== spec) lines.push(`${name}: lock has ${actual[name]}, selection.json wants ${spec}`);
  }
  for (const name of Object.keys(actual)) {
    if (!Object.hasOwn(expected, name)) lines.push(`${name}: in the lock but no longer selected`);
  }
  return lines.sort();
}

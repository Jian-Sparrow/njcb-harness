// Read `package/package.json` out of a packed tarball, without unpacking it.
//
// Two callers need one thing from a `.tgz`: the manifest, and nothing else.
// `add-plugin.mjs` publishes the archive the operator carries in, and
// `build-bundle.mjs` reads the manifest of a locally built package (the plugin
// market) whose `dsh` field the npm lock does not record. Neither may shell out
// to `tar`, which is not guaranteed on a Windows runner, so the ustar header is
// read here.
import zlib from 'node:zlib';

const BLOCK = 512;

/** A NUL-terminated string field out of a tar header. */
function field(header, start, length) {
  const slice = header.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString('utf8');
}

/** A numeric tar header field. Everything npm produces writes octal. */
function octal(header, start, length) {
  const text = field(header, start, length).trim();
  if (text === '') return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error('unsupported tar header (base-256 size encoding)');
  return value;
}

/**
 * The bytes of package/package.json at the top of an uncompressed tar, or
 * null when the archive does not have one there.
 *
 * Only the first level is inspected: a package tarball always starts with its
 * own manifest, and walking a plugin's bundled node_modules to find a nested
 * one would happily read a dependency's manifest as the package's own.
 */
export function topLevelManifest(tar) {
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // Two zero blocks end the archive. One is padding, and a header that is
    // entirely zero is not an entry either way.
    if (header.every(byte => byte === 0)) return null;
    const prefix = field(header, 345, 155);
    const name = field(header, 0, 100).replace(/^\.\//u, '');
    const full = (prefix === '' ? name : `${prefix}/${name}`).replace(/^\.\//u, '');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const start = offset + BLOCK;
    const bytes = octal(header, 124, 12);
    // '0' and NUL are both regular files; a directory named package.json is
    // not one, and reading its zero-byte body would fail as truncated JSON.
    if ((type === '0' || type === '\0') && full === 'package/package.json') {
      return tar.subarray(start, start + bytes);
    }
    offset = start + Math.ceil(bytes / BLOCK) * BLOCK;
  }
  return null;
}

/**
 * The parsed manifest of a packed package, from either a `.tgz` or an
 * uncompressed `.tar`.
 * @param bytes - the archive.
 * @param label - what to call the archive in an error.
 * @returns the manifest, parsed.
 * @throws {Error} when the archive has no top-level manifest, or it is not JSON.
 */
export function readArchiveManifest(bytes, label) {
  // gzip starts 0x1f 0x8b; anything else is taken as a plain tar.
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const tar = gzipped ? zlib.gunzipSync(bytes) : bytes;
  const manifestAt = topLevelManifest(tar);
  if (manifestAt === null) {
    throw new Error(`${label} has no package/package.json at its root; pack it with "npm pack" so the archive has that layout`);
  }
  try {
    return JSON.parse(manifestAt.toString('utf8'));
  } catch (error) {
    throw new Error(`package.json in ${label} is not valid JSON: ${error.message}`);
  }
}

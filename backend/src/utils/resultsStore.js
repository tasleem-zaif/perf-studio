const s3Sync = require('./s3Sync');

// result_dir keeps its exact current shape and meaning to every caller — a path-SHAPED
// naming string built the same way it always was (buildRunDirName, getCollectionPath, etc.)
// — it is simply never created on disk and never touched via fs.*. Every real read/write
// goes through here, which derives the actual S3 key via s3Sync.toKey() (the same
// org-namespacing logic the git-workspace mirror already uses) and talks to S3 directly.

function baseKey(resultDir, orgSlug) {
  return s3Sync.toKey(resultDir, orgSlug);
}

function keyFor(resultDir, orgSlug, relPath) {
  const base = baseKey(resultDir, orgSlug);
  if (!base) return null;
  if (!relPath) return base;
  return `${base}/${String(relPath).replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/** Write a Buffer/string under resultDir at relPath. Returns {ok, key, error?}. */
async function writeFile(resultDir, orgSlug, relPath, data) {
  const key = keyFor(resultDir, orgSlug, relPath);
  if (!key) return { ok: false, error: new Error(`resultsStore: could not derive S3 key for ${resultDir}`) };
  return s3Sync.putBuffer(key, data);
}

/** Read a file back as a Buffer, or null if missing/unavailable. */
async function readFile(resultDir, orgSlug, relPath) {
  const key = keyFor(resultDir, orgSlug, relPath);
  if (!key) return null;
  const res = await s3Sync.getBuffer(key);
  return res.ok ? res.data : null;
}

/** Read a file back as text, or null if missing/unavailable. */
async function readText(resultDir, orgSlug, relPath, encoding = 'utf8') {
  const buf = await readFile(resultDir, orgSlug, relPath);
  return buf ? buf.toString(encoding) : null;
}

/** Whether relPath (or resultDir itself, if relPath omitted) exists. */
async function exists(resultDir, orgSlug, relPath) {
  const key = keyFor(resultDir, orgSlug, relPath);
  return key ? s3Sync.existsKey(key) : false;
}

/** Every file (relative path, not absolute key) under resultDir/subPrefix. */
async function listFiles(resultDir, orgSlug, subPrefix = '') {
  const base = baseKey(resultDir, orgSlug);
  const key = keyFor(resultDir, orgSlug, subPrefix);
  if (!base || !key) return [];
  const keys = await s3Sync.listAllKeys(key);
  return keys.map(k => k.slice(base.length + 1));
}

/**
 * One-level "subdirectory" names directly under resultsParentDir (e.g. run directory
 * names under a `<Collection>/<Env>/results` prefix) — replaces
 * `fs.readdirSync(resultsParentDir, {withFileTypes:true}).filter(isDirectory)` for
 * next-run-number calculation.
 */
async function listRunDirs(resultsParentDir, orgSlug) {
  const key = baseKey(resultsParentDir, orgSlug);
  if (!key) return [];
  return s3Sync.listSubPrefixes(key);
}

/**
 * Write every file entry of an in-memory zip Buffer under resultDir — replaces
 * `new AdmZip(tmpZipPath).extractAllTo(resultDir, true)`. Returns the list of relative
 * paths written.
 */
async function writeZipEntries(resultDir, orgSlug, zipBuffer, { rename } = {}) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipBuffer);
  const written = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    let relPath = entry.entryName;
    if (rename) relPath = rename(relPath);
    if (!relPath) continue;
    const up = await writeFile(resultDir, orgSlug, relPath, entry.getData());
    if (up.ok) written.push(relPath);
  }
  return written;
}

/** Delete everything under resultDir. Returns {ok, deleted, failed}. */
async function deleteAll(resultDir, orgSlug) {
  const key = baseKey(resultDir, orgSlug);
  if (!key) return { ok: false, error: new Error(`resultsStore: could not derive S3 key for ${resultDir}`) };
  return s3Sync.deleteAllUnderPrefix(key);
}

module.exports = {
  writeFile,
  readFile,
  readText,
  exists,
  listFiles,
  listRunDirs,
  writeZipEntries,
  deleteAll,
};

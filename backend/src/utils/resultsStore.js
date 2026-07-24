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

// Bounded-concurrency map — same shape/reasoning as gitEngine.js's own mapLimit (kept as a
// separate copy rather than a shared import — each module owns its own S3 fan-out policy).
// A 100+ file JMeter HTML report used to upload strictly one file at a time (measured: ~15s
// for 120 small files, almost entirely round-trip wait, not actual transfer time). Capping
// concurrency well under the AWS SDK's default 50-socket limit gets the real wall-clock win
// without reintroducing the socket-exhaustion problem gitEngine.js's own fan-out already hit.
const RESULTS_S3_CONCURRENCY = Number(process.env.RESULTS_S3_CONCURRENCY) || 16;
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function writeOneEntry(resultDir, orgSlug, relPath, data) {
  let up = { ok: false };
  for (let attempt = 1; attempt <= 3 && !up.ok; attempt++) {
    up = await writeFile(resultDir, orgSlug, relPath, data);
    if (!up.ok && attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  return up.ok ? { relPath, ok: true } : { relPath, ok: false, error: up.error };
}

/**
 * Write every file entry of an in-memory zip Buffer under resultDir — replaces
 * `new AdmZip(tmpZipPath).extractAllTo(resultDir, true)`. Returns { written, failed }.
 *
 * `results.jtl` (the one file every downstream feature actually depends on) is written FIRST,
 * awaited alone, before anything else starts — it's typically the LAST entry in the zip's own
 * central directory (JMeter writes it before the html/ report), so leaving it to naturally take
 * its turn meant 119 decorative CSS/JS/font files for the static report had to get through
 * first. The rest upload with bounded concurrency instead of one at a time — a transient
 * failure on any entry retries a few times (writeOneEntry) rather than being silently dropped;
 * `failed` lets callers tell a genuine empty JTL apart from "the upload didn't actually happen".
 */
async function writeZipEntries(resultDir, orgSlug, zipBuffer, { rename } = {}) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipBuffer);
  const entries = [];
  const failed = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    let relPath = entry.entryName;
    if (rename) relPath = rename(relPath);
    if (!relPath) continue;
    try {
      entries.push({ relPath, data: entry.getData() });
    } catch (e) {
      failed.push({ relPath, error: e });
    }
  }

  const priority = entries.filter(e => e.relPath === 'results.jtl');
  const rest = entries.filter(e => e.relPath !== 'results.jtl');

  const written = [];
  for (const e of priority) {
    const r = await writeOneEntry(resultDir, orgSlug, e.relPath, e.data);
    if (r.ok) written.push(r.relPath); else failed.push(r);
  }
  const restResults = await mapLimit(rest, RESULTS_S3_CONCURRENCY, e => writeOneEntry(resultDir, orgSlug, e.relPath, e.data));
  for (const r of restResults) {
    if (r.ok) written.push(r.relPath); else failed.push(r);
  }

  return { written, failed };
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

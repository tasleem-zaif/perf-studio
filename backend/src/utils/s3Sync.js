const path = require('path');
const fs = require('fs');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { GIT_WORKSPACES_ROOT, PROJECTS_ROOT, BACKUPS_ROOT } = require('./projectFolders');
const { alertOpsFailure } = require('./opsAlert');

const S3_SYNC_ENABLED = String(process.env.S3_SYNC_ENABLED || '').toLowerCase() === 'true';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || 'git-workspaces').replace(/^\/+|\/+$/g, '');
const UNASSIGNED_ORG = 'unassigned';

let client = null;
function getClient() {
  if (client) return client;
  client = new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined, // allows pointing at MinIO/other S3-compatible endpoints later
    forcePathStyle: !!process.env.S3_ENDPOINT,
    credentials: process.env.S3_ACCESS_KEY_ID
      ? {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        }
      : undefined, // falls back to the default AWS credential chain (instance role, etc.)
  });
  return client;
}

function isEnabled() {
  return S3_SYNC_ENABLED && !!S3_BUCKET;
}

// Bounded-concurrency map — same shape as gitEngine.js's/resultsStore.js's own copies (each
// module keeps its own rather than sharing one). uploadDir()/downloadDir() back a git working
// tree mirror and native-execution result dirs, both of which can be hundreds of files — doing
// them one at a time was the same "everything waits on the previous file's full round trip"
// cost as the JMeter-report case, just for different callers (git.js, execution.js,
// testRunner.js, autoHealer.js, workspaceLifecycle.js).
const S3_FANOUT_CONCURRENCY = Number(process.env.S3_FANOUT_CONCURRENCY) || 16;
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

/** Report a real S3 operation failure to ops (webhook/email) instead of just console.error. */
function reportFailure(op, keyOrDir, error) {
  alertOpsFailure(
    `s3_${op}_failure`,
    `S3 ${op} failed`,
    `Operation: ${op}\nBucket: ${S3_BUCKET}\nKey/path: ${keyOrDir || '(n/a)'}\nError: ${error?.message || error}`
  );
}

/**
 * Refuse-to-start check: throws if S3 isn't configured, or configured but unreachable
 * (bad credentials, wrong region, bucket doesn't exist, network-blocked). Called once at
 * boot (index.js) — this app's zero-local-disk guarantee depends entirely on S3 being up.
 */
async function assertBucketReachable() {
  if (!isEnabled()) {
    throw new Error(
      'S3_SYNC_ENABLED=true and S3_BUCKET must both be set. This deployment stores all ' +
      'customer data (git workspaces, run results, artifacts) via S3 only — see PROJECT_MAP.md ' +
      '"S3 migration" for why local-disk storage was retired (GDPR).'
    );
  }
  try {
    await getClient().send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch (error) {
    // HeadBucket errors carry no body, so error.message is often the unhelpful literal
    // "UnknownError" — error.name (e.g. NotFound/Forbidden) + the real HTTP status is what
    // actually explains what's wrong (bucket missing vs. bad credentials vs. wrong region).
    const status = error?.$metadata?.httpStatusCode;
    const reason = [error?.name, status ? `HTTP ${status}` : null, error?.message].filter(Boolean).join(' — ');
    throw new Error(
      `S3 bucket "${S3_BUCKET}" (region=${process.env.S3_REGION || '(default)'}) is not reachable: ${reason}`
    );
  }
}

/** Non-blocking boot-time nudge toward least-privilege IAM (instance/task role over static keys). */
function warnIfInsecureCredentials() {
  if (process.env.NODE_ENV === 'production' && process.env.S3_ACCESS_KEY_ID) {
    console.warn(
      '[S3] Using static S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY in production. Prefer an IAM ' +
      'instance/task role (omit both env vars — the AWS SDK default credential chain picks it up ' +
      'automatically) for least-privilege, rotation-free access when running on AWS (EC2/ECS/EKS).'
    );
  }
}

// PROJECTS_ROOT/BACKUPS_ROOT are NOT guaranteed to be nested under GIT_WORKSPACES_ROOT —
// in both the local .env and docker-compose.yml they're configured as sibling directories
// (../projects, ../backups vs. git-workspaces/). execution.js already treats these as
// distinct roots when resolving report_url, so s3Sync mirrors that same multi-root model
// rather than assuming everything lives under one tree.
// Order matters: check the most specific/likely-nested root first.
function knownRoots() {
  return [
    { name: 'backups', root: BACKUPS_ROOT },
    { name: 'workspaces', root: GIT_WORKSPACES_ROOT },
    { name: 'projects', root: PROJECTS_ROOT },
  ].filter(r => !!r.root);
}

function cleanOrgSlug(orgSlug) {
  return (orgSlug || UNASSIGNED_ORG).replace(/[^a-zA-Z0-9_-]/g, '_') || UNASSIGNED_ORG;
}

/**
 * Convert a local absolute path into an S3 key, namespaced by organization —
 * the bucket is a shared, central store across every org/project (unlike local disk,
 * which is already segregated by directory tree), so every key groups under
 * <prefix>/<org>/... regardless of which root the path came from.
 * `orgSlug` should come from `projectFolders.resolveOrgSlugForProject(projectId)` —
 * pass it explicitly rather than trying to reverse-parse it out of the path, since a
 * cleaned project-name folder segment doesn't uniquely/reliably map back to an org.
 * Returns null (never throws) if the path isn't under any known root.
 */
function toKey(localPath, orgSlug) {
  for (const { name, root } of knownRoots()) {
    const rel = path.relative(root, localPath);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) continue;
    // Keep the original flat layout for the primary workspaces root (already the
    // convention every existing sync call site was validated against); namespace the
    // others so they can't collide with it or with each other.
    const nsPrefix = name === 'workspaces' ? S3_PREFIX : `${S3_PREFIX}-${name}`;
    const org = cleanOrgSlug(orgSlug);
    const relParts = rel === '' ? [] : rel.split(path.sep);
    // A brand-new project's local path is itself org-prefixed now (git-workspaces/<org>/
    // <project>/...), so `rel`'s first segment may already equal `org` — strip it here
    // rather than let the `base` prefix below add it a second time. An older, pre-org-prefix
    // local path never has this first segment, so this is a no-op for every existing project.
    if (relParts[0] === org) relParts.shift();
    const relKey = relParts.join('/');
    const base = `${nsPrefix}/${org}`;
    return relKey ? `${base}/${relKey}` : base;
  }
  // Every caller (resultsStore.js, gitEngine.js, ...) treats a null key exactly like "file
  // legitimately doesn't exist yet" — no error, just an empty/null read. That's indistinguishable
  // from the real failure mode: localPath was computed against a GIT_WORKSPACES_ROOT/PROJECTS_ROOT/
  // BACKUPS_ROOT value that doesn't match what's configured now (e.g. a stored DB path — a
  // project's folder_path, a run's result_dir — computed under a different root config than the
  // one this process is currently running with), so it silently never matches ANY known root and
  // every downstream feature reading it just gets empty data with no trail to explain why.
  console.warn(`[s3Sync] toKey: "${localPath}" is not under any known root — ` +
    knownRoots().map(r => `${r.name}=${r.root}`).join(', '));
  return null;
}

/** Upload a single local file to its mirrored S3 key. Returns {ok, key, error?} — never throws. */
async function uploadFile(localPath, orgSlug) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const key = toKey(localPath, orgSlug);
  if (!key) return { ok: false, error: new Error(`s3Sync: ${localPath} is not under any known root`) };
  try {
    // Same reasoning as putBuffer's threshold below: most files here (git-workspace source
    // files, config.json, small CSVs) are tiny — reading them into memory and issuing a plain
    // PutObjectCommand skips the Upload class's multipart bookkeeping entirely. Only large
    // files (rare — an uploaded test-data CSV, say) keep the streamed multipart-capable path.
    const stat = fs.statSync(localPath);
    if (stat.size < MULTIPART_THRESHOLD_BYTES) {
      await getClient().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: fs.readFileSync(localPath) }));
    } else {
      const body = fs.createReadStream(localPath);
      const uploader = new Upload({
        client: getClient(),
        params: { Bucket: S3_BUCKET, Key: key, Body: body },
      });
      await uploader.done();
    }
    return { ok: true, key };
  } catch (error) {
    reportFailure('upload', key, error);
    return { ok: false, key, error };
  }
}

/** Download the S3-mirrored object for localPath back to that path, creating parent dirs. Returns {ok, key, error?}. */
async function downloadFile(localPath, orgSlug) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const key = toKey(localPath, orgSlug);
  if (!key) return { ok: false, error: new Error(`s3Sync: ${localPath} is not under any known root`) };
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    await new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(localPath);
      res.Body.pipe(dest);
      res.Body.on('error', reject);
      dest.on('error', reject);
      dest.on('finish', resolve);
    });
    return { ok: true, key };
  } catch (error) {
    reportFailure('download', key, error);
    return { ok: false, key, error };
  }
}

/** Delete the mirrored S3 object for localPath (tombstone for local deletes). Returns {ok, key, error?}. */
async function deleteObject(localPath, orgSlug) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const key = toKey(localPath, orgSlug);
  if (!key) return { ok: false, error: new Error(`s3Sync: ${localPath} is not under any known root`) };
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return { ok: true, key };
  } catch (error) {
    reportFailure('delete', key, error);
    return { ok: false, key, error };
  }
}

/** Check whether localPath has a mirrored S3 object. Returns boolean; returns false (not error) if S3 is unreachable. */
async function existsInS3(localPath, orgSlug) {
  if (!isEnabled()) return false;
  const key = toKey(localPath, orgSlug);
  if (!key) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Recursively upload every file under localDir, optionally skipping named subdirs. Returns {ok, uploaded, failed}. */
async function uploadDir(localDir, orgSlug, { skipDirs = [] } = {}) {
  if (!isEnabled()) return { ok: false, skipped: true };
  if (!fs.existsSync(localDir)) return { ok: true, uploaded: [], failed: [] };
  const uploaded = [];
  const failed = [];
  const walk = (dir) => {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && skipDirs.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...walk(full));
      else if (entry.isFile()) files.push(full);
    }
    return files;
  };
  // Was one-at-a-time (a git working tree or a native execution's result dir can easily be
  // hundreds of files) — bounded concurrency instead, same reasoning/cap as resultsStore.js's
  // writeZipEntries fix (well under the AWS SDK's 50-socket default).
  const results = await mapLimit(walk(localDir), S3_FANOUT_CONCURRENCY, async (file) => {
    const result = await uploadFile(file, orgSlug);
    return { file, result };
  });
  for (const { file, result } of results) {
    if (result.ok) uploaded.push(file);
    else failed.push({ file, error: result.error });
  }
  // Per-file failures already alerted individually via uploadFile()'s own reportFailure —
  // no aggregate alert here to avoid double-reporting the same underlying errors.
  return { ok: failed.length === 0, uploaded, failed };
}

/** Mirror a git working tree to S3, skipping .git/ internals — those are recoverable via a
 * fresh clone from the configured remote, so there's no need to serialize git's object store. */
async function uploadWorkingTree(gitDir, orgSlug) {
  return uploadDir(gitDir, orgSlug, { skipDirs: ['.git'] });
}

/** Delete every S3 object mirrored under localDir's prefix (tombstone for a local folder delete). */
async function deleteDir(localDir, orgSlug) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const key = toKey(localDir, orgSlug);
  if (!key) return { ok: false, error: new Error(`s3Sync: ${localDir} is not under any known root`) };
  const prefix = `${key}/`;
  const deleted = [];
  const failed = [];
  try {
    let continuationToken;
    do {
      const res = await getClient().send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      const pageResults = await mapLimit(res.Contents || [], S3_FANOUT_CONCURRENCY, async (obj) => {
        try {
          await getClient().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
          return { key: obj.Key, ok: true };
        } catch (error) {
          return { key: obj.Key, ok: false, error };
        }
      });
      for (const r of pageResults) {
        if (r.ok) deleted.push(r.key);
        else failed.push({ key: r.key, error: r.error });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    reportFailure('deleteDir', prefix, error);
    return { ok: false, deleted, failed, error };
  }
  if (failed.length) reportFailure('deleteDir', prefix, new Error(`${failed.length} object(s) failed to delete, e.g. ${failed[0].error?.message}`));
  return { ok: failed.length === 0, deleted, failed };
}

/** Download every object under localDir's mirrored S3 prefix into localDir. Returns {ok, downloaded, failed}. */
async function downloadDir(localDir, orgSlug) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const key = toKey(localDir, orgSlug);
  if (!key) return { ok: false, error: new Error(`s3Sync: ${localDir} is not under any known root`) };
  const prefix = `${key}/`;
  const downloaded = [];
  const failed = [];
  try {
    let continuationToken;
    do {
      const res = await getClient().send(new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      // Pagination itself is inherently sequential (each page's token depends on the last),
      // but the downloads WITHIN a page don't depend on each other — same bounded-concurrency
      // fix as uploadDir, for the same "workspace restore blocking on hundreds of files" cost.
      const pageResults = await mapLimit(res.Contents || [], S3_FANOUT_CONCURRENCY, async (obj) => {
        const rel = obj.Key.slice(prefix.length);
        if (!rel) return null;
        const localPath = path.join(localDir, ...rel.split('/'));
        const result = await downloadFile(localPath, orgSlug);
        return { localPath, result };
      });
      for (const r of pageResults) {
        if (!r) continue;
        if (r.result.ok) downloaded.push(r.localPath);
        else failed.push({ file: r.localPath, error: r.result.error });
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    return { ok: false, downloaded, failed, error };
  }
  return { ok: failed.length === 0, downloaded, failed };
}

// ── Raw key-based primitives — no local path involved at all ──────────────────
// Used by resultsStore.js, which derives a key via toKey() from a path-SHAPED naming
// string (never actually created on disk) and then reads/writes S3 directly through these.

// @aws-sdk/lib-storage's Upload class exists for streamed/large bodies that may need
// multipart — it does real bookkeeping (part-size calc, multipart-vs-single decision, extra
// promise orchestration) on every call to figure that out, even for a 200-byte CSS file. Most
// callers here (a JMeter HTML report's ~100+ small asset files) never need any of that. Below
// this threshold, skip Upload entirely and issue a single plain PutObjectCommand — same result,
// meaningfully less overhead per call across a report's worth of small files.
const MULTIPART_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Upload an in-memory buffer/string/stream to an explicit S3 key. Returns {ok, key, error?}. */
async function putBuffer(key, body) {
  if (!isEnabled()) return { ok: false, skipped: true };
  try {
    const size = Buffer.isBuffer(body) ? body.length : (typeof body === 'string' ? Buffer.byteLength(body) : null);
    if (size !== null && size < MULTIPART_THRESHOLD_BYTES) {
      await getClient().send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body }));
    } else {
      const uploader = new Upload({ client: getClient(), params: { Bucket: S3_BUCKET, Key: key, Body: body } });
      await uploader.done();
    }
    return { ok: true, key };
  } catch (error) {
    reportFailure('putBuffer', key, error);
    return { ok: false, key, error };
  }
}

/** Download an explicit S3 key into a Buffer. Returns {ok, key, data?, error?}. */
async function getBuffer(key) {
  if (!isEnabled()) return { ok: false, skipped: true };
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return { ok: true, key, data: Buffer.concat(chunks) };
  } catch (error) {
    reportFailure('getBuffer', key, error);
    return { ok: false, key, error };
  }
}

/** Delete a single explicit S3 key. Returns {ok, key, error?}. */
async function deleteKey(key) {
  if (!isEnabled()) return { ok: false, skipped: true };
  try {
    await getClient().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return { ok: true, key };
  } catch (error) {
    reportFailure('deleteKey', key, error);
    return { ok: false, key, error };
  }
}

/** Check whether an explicit S3 key exists. Returns false (not error) if unreachable/missing. */
async function existsKey(key) {
  if (!isEnabled()) return false;
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** One level of "virtual subdirectory" names directly under prefix (S3 CommonPrefixes via Delimiter). */
async function listSubPrefixes(prefix) {
  if (!isEnabled()) return [];
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const names = [];
  let continuationToken;
  do {
    const res = await getClient().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: p, Delimiter: '/', ContinuationToken: continuationToken }));
    for (const cp of res.CommonPrefixes || []) {
      const name = cp.Prefix.slice(p.length).replace(/\/$/, '');
      if (name) names.push(name);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return names;
}

/** Every object key (recursively, not just one level) under prefix. */
async function listAllKeys(prefix) {
  if (!isEnabled()) return [];
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const keys = [];
  let continuationToken;
  do {
    const res = await getClient().send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: p, ContinuationToken: continuationToken }));
    for (const obj of res.Contents || []) keys.push(obj.Key);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

/** Delete every object under prefix. Returns {ok, deleted, failed}. */
async function deleteAllUnderPrefix(prefix) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const keys = await listAllKeys(prefix);
  const results = await mapLimit(keys, S3_FANOUT_CONCURRENCY, async (key) => {
    try {
      await getClient().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      return null;
    } catch (error) {
      return { key, error };
    }
  });
  const failed = results.filter(Boolean);
  if (failed.length) reportFailure('deleteAllUnderPrefix', prefix, new Error(`${failed.length} object(s) failed to delete, e.g. ${failed[0].error?.message}`));
  return { ok: failed.length === 0, deleted: keys.length - failed.length, failed };
}

module.exports = {
  isEnabled,
  assertBucketReachable,
  warnIfInsecureCredentials,
  toKey,
  uploadFile,
  downloadFile,
  deleteObject,
  existsInS3,
  uploadDir,
  downloadDir,
  uploadWorkingTree,
  deleteDir,
  putBuffer,
  getBuffer,
  deleteKey,
  existsKey,
  listSubPrefixes,
  listAllKeys,
  deleteAllUnderPrefix,
};

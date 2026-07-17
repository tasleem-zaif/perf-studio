const path = require('path');
const fs = require('fs');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { GIT_WORKSPACES_ROOT, PROJECTS_ROOT, BACKUPS_ROOT } = require('./projectFolders');

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
  return null;
}

/** Upload a single local file to its mirrored S3 key. Returns {ok, key, error?} — never throws. */
async function uploadFile(localPath, orgSlug) {
  if (!isEnabled()) return { ok: false, skipped: true };
  const key = toKey(localPath, orgSlug);
  if (!key) return { ok: false, error: new Error(`s3Sync: ${localPath} is not under any known root`) };
  try {
    const body = fs.createReadStream(localPath);
    const uploader = new Upload({
      client: getClient(),
      params: { Bucket: S3_BUCKET, Key: key, Body: body },
    });
    await uploader.done();
    return { ok: true, key };
  } catch (error) {
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
  for (const file of walk(localDir)) {
    const result = await uploadFile(file, orgSlug);
    if (result.ok) uploaded.push(file);
    else failed.push({ file, error: result.error });
  }
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
      for (const obj of res.Contents || []) {
        try {
          await getClient().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: obj.Key }));
          deleted.push(obj.Key);
        } catch (error) {
          failed.push({ key: obj.Key, error });
        }
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
  } catch (error) {
    return { ok: false, deleted, failed, error };
  }
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
      for (const obj of res.Contents || []) {
        const rel = obj.Key.slice(prefix.length);
        if (!rel) continue;
        const localPath = path.join(localDir, ...rel.split('/'));
        const result = await downloadFile(localPath, orgSlug);
        if (result.ok) downloaded.push(localPath);
        else failed.push({ file: localPath, error: result.error });
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

/** Upload an in-memory buffer/string/stream to an explicit S3 key. Returns {ok, key, error?}. */
async function putBuffer(key, body) {
  if (!isEnabled()) return { ok: false, skipped: true };
  try {
    const uploader = new Upload({ client: getClient(), params: { Bucket: S3_BUCKET, Key: key, Body: body } });
    await uploader.done();
    return { ok: true, key };
  } catch (error) {
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
  const failed = [];
  for (const key of keys) {
    try {
      await getClient().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    } catch (error) {
      failed.push({ key, error });
    }
  }
  return { ok: failed.length === 0, deleted: keys.length - failed.length, failed };
}

module.exports = {
  isEnabled,
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
  existsKey,
  listSubPrefixes,
  listAllKeys,
  deleteAllUnderPrefix,
};

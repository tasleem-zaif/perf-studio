/**
 * scriptEncryption.js — per-org script encryption for content pushed to a customer's git repo
 *
 * Only the copy of a generated .jmx/.js script that actually lands in the customer's own
 * GitHub/GitLab/Bitbucket repository gets encrypted with this — see ciPipeline.js's /trigger
 * route, where the script is re-staged and pushed immediately before every CI dispatch. Peako's
 * own working copies (the PAT-mode git session, SSH-mode local disk + S3 mirror) are never
 * touched by this and stay plaintext, since internal features (auto-heal, script generation)
 * depend on reading them directly.
 *
 * Each org gets its own random AES-256 key, generated lazily and stored wrapped with the app's
 * master key via encryption.js's encrypt()/decrypt() — same envelope pattern already used for
 * organizations.registry_token_enc. Disabling an org's license (setOrgStatus) doesn't touch this
 * key directly, but the CI decrypt-serving endpoint checks license validity before ever handing
 * back plaintext, so revocation is enforced there, not by rotating this key.
 *
 * Usage:
 *   const { encryptScript, decryptScript } = require('./scriptEncryption');
 *   const ciphertext = await encryptScript(plainJmxOrJs, orgId);   // write this into the git push
 *   const plaintext  = await decryptScript(ciphertext, orgId);     // verification/DR only
 */

const crypto = require('crypto');
const db = require('../db');
const { encrypt, decrypt } = require('./encryption');

const ALGORITHM = 'aes-256-gcm';
const FORMAT_PREFIX = 'PSENC1';

/**
 * Fetch this org's raw AES-256 script key, generating and persisting one on first use.
 * Returns a 32-byte Buffer.
 */
async function getOrCreateOrgScriptKey(orgId) {
  const row = await db.prepare('SELECT script_key_enc FROM org_licenses WHERE org_id = ?').get(orgId);
  if (row?.script_key_enc) {
    return Buffer.from(decrypt(row.script_key_enc), 'hex');
  }

  const rawKey = crypto.randomBytes(32);
  const wrapped = encrypt(rawKey.toString('hex'));
  // UPDATE, not INSERT — this is only ever reached after reserveVuh() has already confirmed
  // an org_licenses row exists for this org, so an INSERT here would risk creating a malformed
  // row (missing the trial defaults getOrCreateOrgLicense() normally sets) if that assumption
  // ever breaks. The IS NULL guard avoids clobbering a key another concurrent request just set.
  await db.prepare(`
    UPDATE org_licenses SET script_key_enc = ? WHERE org_id = ? AND script_key_enc IS NULL
  `).run(wrapped, orgId);

  // Someone else may have won a concurrent update race — re-read rather than trust the value
  // we just generated, so every caller ends up using the same, single org key.
  const final = await db.prepare('SELECT script_key_enc FROM org_licenses WHERE org_id = ?').get(orgId);
  if (!final?.script_key_enc) throw new Error(`No org_licenses row found for org ${orgId} — cannot create script key`);
  return Buffer.from(decrypt(final.script_key_enc), 'hex');
}

/**
 * Encrypt plaintext script content for this org. Returns a versioned, self-describing string
 * safe to write directly as the file content pushed to the customer's git repo.
 */
async function encryptScript(plaintext, orgId) {
  const key = await getOrCreateOrgScriptKey(orgId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [FORMAT_PREFIX, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypt a payload produced by encryptScript() for the same org. Not on the runtime CI-serving
 * path (that reads Peako's own plaintext copy instead) — this exists for write-time round-trip
 * verification and any future disaster-recovery tooling.
 */
async function decryptScript(payload, orgId) {
  const parts = (payload || '').split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_PREFIX) {
    throw new Error('Not a recognized encrypted script payload');
  }
  const [, ivB64, authTagB64, ciphertextB64] = parts;
  const key = await getOrCreateOrgScriptKey(orgId);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { getOrCreateOrgScriptKey, encryptScript, decryptScript };

/**
 * encryption.js — AES-256-CBC encrypt/decrypt using Node built-in crypto.
 *
 * The encryption key is derived from the JWT_SECRET env var (or a fallback).
 * Format stored in DB:  <iv_hex>:<ciphertext_hex>
 *
 * Usage:
 *   const { encrypt, decrypt } = require('./encryption');
 *   const stored = encrypt('sk-abc123');   // store this in DB
 *   const plain  = decrypt(stored);        // 'sk-abc123'
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';

// Derive a 32-byte key from whatever secret is available
function getKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'perf-studio-default-enc-key-2026';
  // SHA-256 of the secret gives us exactly 32 bytes
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt plain text. Returns '<iv_hex>:<cipher_hex>' or the original
 * value unchanged if encryption fails (graceful degradation).
 */
function encrypt(plainText) {
  if (!plainText) return plainText;
  // Already encrypted (contains our separator)
  if (typeof plainText === 'string' && plainText.includes(':') && plainText.length > 64) return plainText;
  try {
    const key = getKey();
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  } catch (e) {
    console.error('[Encryption] encrypt failed:', e.message);
    return plainText; // store as-is rather than lose the key
  }
}

/**
 * Decrypt a stored value. Returns the plain text, or the original
 * value unchanged if it doesn't look encrypted.
 */
function decrypt(stored) {
  if (!stored) return stored;
  if (typeof stored !== 'string' || !stored.includes(':')) return stored; // not encrypted
  try {
    const [ivHex, cipherHex] = stored.split(':');
    if (!ivHex || !cipherHex) return stored;
    const key      = getKey();
    const iv       = Buffer.from(ivHex, 'hex');
    const cipher   = Buffer.from(cipherHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    // Decryption failed — likely stored as plain text (legacy), return as-is
    return stored;
  }
}

/**
 * Returns true if the value looks like it was encrypted by us.
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 2 && parts[0].length === 32 && parts[1].length > 0;
}

module.exports = { encrypt, decrypt, isEncrypted };

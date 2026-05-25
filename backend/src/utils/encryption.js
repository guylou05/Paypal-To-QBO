const crypto = require('crypto');
const config  = require('../config');

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 16;
const TAG_LENGTH = 16;

function getKey() {
  const hex = config.encryptionKey;
  if (!hex || hex.length < 64) {
    throw new Error('ENCRYPTION_KEY must be at least 32 bytes (64 hex chars)');
  }
  return Buffer.from(hex.slice(0, 64), 'hex');
}

/**
 * Encrypt a string. Returns base64: iv:tag:ciphertext
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

/**
 * Decrypt a string produced by encrypt().
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const key = getKey();
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('Invalid ciphertext format');
  const iv       = Buffer.from(ivHex,  'hex');
  const tag      = Buffer.from(tagHex, 'hex');
  const data     = Buffer.from(dataHex,'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };

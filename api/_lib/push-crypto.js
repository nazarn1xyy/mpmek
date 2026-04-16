/**
 * AES-256-GCM encryption for push subscription objects at rest in Redis.
 *
 * Threat model: if Redis is compromised, attacker cannot read push endpoints
 * (which may contain per-user identifiers that link push notifications to users).
 *
 * Note: sending push notifications still requires the VAPID_PRIVATE_KEY, which
 * lives in server env. So without this encryption, a Redis leak + VAPID leak
 * would let an attacker impersonate the server.  With this encryption, Redis
 * leak alone reveals nothing useful.
 *
 * Key: PUSH_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Backward-compatible: if key missing or payload has no `enc:` prefix, falls
 * through to plaintext (for legacy entries created before this rolled out).
 */
const crypto = require('crypto');

const KEY_HEX = process.env.PUSH_ENCRYPTION_KEY;
const KEY = KEY_HEX && KEY_HEX.length === 64
  ? Buffer.from(KEY_HEX, 'hex')
  : null;

/**
 * Encrypt a subscription object. Returns a plain subscription object unchanged
 * if no key is configured (graceful degradation during rollout).
 */
function encryptSubscription(subscription) {
  if (!KEY) return { subscription }; // fallback: plaintext

  const plaintext = JSON.stringify(subscription);
  const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Pack: base64(iv):base64(tag):base64(ciphertext)
  const payload = `enc:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  return { subscriptionEnc: payload };
}

/**
 * Decrypt a subscription payload. Returns the subscription object or null if decryption fails.
 * Accepts both new (subscriptionEnc) and legacy (subscription) entry shapes.
 */
function decryptSubscription(entry) {
  if (!entry) return null;
  // Legacy: plaintext subscription object
  if (entry.subscription && typeof entry.subscription === 'object') {
    return entry.subscription;
  }
  // New: encrypted payload
  if (typeof entry.subscriptionEnc !== 'string') return null;
  if (!KEY) return null; // shouldn't happen if we have encrypted payload
  if (!entry.subscriptionEnc.startsWith('enc:')) return null;

  try {
    const [, ivB, tagB, encB] = entry.subscriptionEnc.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encB, 'base64')),
      decipher.final()
    ]).toString('utf-8');
    return JSON.parse(plaintext);
  } catch (e) {
    console.warn('Push subscription decrypt failed:', e.message);
    return null;
  }
}

module.exports = { encryptSubscription, decryptSubscription, hasEncryptionKey: !!KEY };

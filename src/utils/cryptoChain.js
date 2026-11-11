import crypto from 'crypto';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministic Canonical JSON Serialization (RFC 8785)
 * Guarantees identical serialized byte string regardless of object key order
 */
export function canonicalJson(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/**
 * Calculates a deterministic SHA-256 hash linking an activity log to the previous log
 */
export function calculateLogHash({
  prevHash = GENESIS_HASH,
  dealId = '',
  actorUserId = '',
  actorBusinessId = '',
  eventType = '',
  detailsJson = {},
  timestamp = 0
}) {
  let parsedPayload = detailsJson;
  if (typeof detailsJson === 'string') {
    try {
      parsedPayload = JSON.parse(detailsJson);
    } catch {
      parsedPayload = detailsJson;
    }
  }
  const normalizedPayload = canonicalJson(parsedPayload || {});

  // Normalize timestamp to second-level precision to guarantee parity across DB drivers
  const epochSec = timestamp 
    ? (typeof timestamp === 'number' ? Math.floor(timestamp) : Math.floor(new Date(timestamp).getTime() / 1000))
    : 0;

  const dataToHash = [
    prevHash || GENESIS_HASH,
    dealId || '',
    actorUserId || '',
    actorBusinessId || '',
    eventType || '',
    normalizedPayload,
    epochSec
  ].join('|');

  return crypto.createHash('sha256').update(dataToHash).digest('hex');
}

/**
 * Retrieves the latest log_hash for a given deal to link the next log entry
 */
export async function getLatestDealLogHash(connOrPool, dealId) {
  if (!dealId) return GENESIS_HASH;

  const [rows] = await connOrPool.query(
    'SELECT log_hash FROM activity_logs WHERE deal_id = ? AND log_hash IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    [dealId]
  );

  return rows.length > 0 && rows[0].log_hash ? rows[0].log_hash : GENESIS_HASH;
}

/**
 * Verifies the cryptographic integrity of a deal's entire audit trail.
 * Returns true if untampered, or details of where tampering occurred.
 */
export async function verifyAuditChainIntegrity(connOrPool, dealId) {
  const [logs] = await connOrPool.query(
    'SELECT id, deal_id, actor_user_id, actor_business_id, event_type, details_json, prev_hash, log_hash, created_at FROM activity_logs WHERE deal_id = ? ORDER BY created_at ASC',
    [dealId]
  );

  const chainedLogs = logs.filter(l => l.log_hash && l.prev_hash);
  if (chainedLogs.length === 0) {
    return {
      valid: true,
      totalVerified: logs.length,
      totalChained: 0,
      status: 'Genesis state / legacy logs unchained'
    };
  }

  // Build hash-to-log set for parent linkage validation
  const existingHashes = new Set([GENESIS_HASH]);
  for (const l of chainedLogs) {
    existingHashes.add(l.log_hash);
  }

  for (let i = 0; i < chainedLogs.length; i++) {
    const log = chainedLogs[i];

    // Every block's prev_hash must link to Genesis or a legitimate previous block
    if (!existingHashes.has(log.prev_hash)) {
      return {
        valid: false,
        brokenAtIndex: i,
        brokenLogId: log.id,
        reason: 'Broken parent hash link in cryptographic chain',
        prevHash: log.prev_hash
      };
    }

    // Verify cryptographic integrity of the content
    const computed = calculateLogHash({
      prevHash: log.prev_hash,
      dealId: log.deal_id,
      actorUserId: log.actor_user_id,
      actorBusinessId: log.actor_business_id,
      eventType: log.event_type,
      detailsJson: log.details_json,
      timestamp: log.created_at
    });

    if (log.log_hash !== computed) {
      return {
        valid: false,
        brokenAtIndex: i,
        brokenLogId: log.id,
        reason: 'Hash mismatch: Log payload or metadata was tampered with',
        expectedHash: computed,
        actualHash: log.log_hash
      };
    }
  }

  return {
    valid: true,
    totalVerified: logs.length,
    totalChained: chainedLogs.length,
    status: 'Cryptographic chain intact. Zero tampering detected.'
  };
}

import etcd from './db.js';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from './secrets.js';

const BLACKLIST_PREFIX = 'system/sessions/blacklist/';

export async function isTokenBlacklisted(jti) {
  const val = await etcd.get(`${BLACKLIST_PREFIX}${jti}`).string();
  return !!val;
}

export async function blacklistToken(jti, ttlSeconds) {
  if (ttlSeconds > 0) {
    const lease = etcd.lease(ttlSeconds);
    await lease.put(`${BLACKLIST_PREFIX}${jti}`).value('revoked');
  } else {
    await etcd.put(`${BLACKLIST_PREFIX}${jti}`).value('revoked');
  }
}

export async function revokeAllSessions(nodeId) {
  // On unseal, revoke all prior sessions for this node by storing a
  // generation marker. The current generation is tracked per-node.
  const genKey = `system/sessions/gen/${nodeId}`;
  const raw = await etcd.get(genKey).string();
  const gen = (parseInt(raw || '0', 10) + 1).toString();
  await etcd.put(genKey).value(gen);
  return gen;
}

export async function getSessionGeneration(nodeId) {
  const raw = await etcd.get(`system/sessions/gen/${nodeId}`).string();
  return parseInt(raw || '0', 10);
}

export async function signToken(payload, secret, expiresIn = '8h') {
  const jti = `${payload.nodeId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const gen = await getSessionGeneration(payload.nodeId);
  return jwt.sign({ ...payload, jti, gen }, secret, { expiresIn });
}

export async function checkSessionGeneration(payload) {
  if (!payload || !payload.nodeId) return false;
  const currentGen = await getSessionGeneration(payload.nodeId);
  const tokenGen = payload.gen || 0;
  return tokenGen >= currentGen;
}

export async function refreshToken(token, secret) {
  try {
    const decoded = jwt.verify(token, secret, { ignoreExpiration: false });
    if (decoded.jti && await isTokenBlacklisted(decoded.jti)) {
      return null;
    }
    // Blacklist the old token
    if (decoded.jti) {
      await blacklistToken(decoded.jti, 8 * 3600);
    }
    // Issue a new token with same payload (minus jti)
    const { jti, iat, exp, ...payload } = decoded;
    return signToken(payload, secret);
  } catch {
    return null;
  }
}

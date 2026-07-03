/**
 * In-memory sliding-window rate limiter keyed by IP string.
 *
 * Module-level state is intentional: the Map lives for the lifetime of the
 * Next.js server process and is shared across all requests handled by the
 * same worker.  It is NOT shared across multiple worker processes / replicas;
 * for multi-replica deployments replace this with a Redis-backed solution.
 */

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const store = new Map<string, RateLimitEntry>();

/**
 * Check whether `ip` has exceeded `maxRequests` within the rolling
 * `windowMs` millisecond window.
 *
 * Side-effect: increments the request counter for this IP when allowed.
 * Also evicts stale entries on every call to keep memory bounded.
 *
 * @returns `true` if the request is allowed, `false` if the limit is exceeded.
 */
export function checkRateLimit(ip: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();

  // Sweep stale entries first to avoid unbounded growth.
  for (const [key, entry] of store) {
    if (now - entry.windowStart >= windowMs) {
      store.delete(key);
    }
  }

  const existing = store.get(ip);

  if (!existing || now - existing.windowStart >= windowMs) {
    // Start a fresh window for this IP.
    store.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (existing.count >= maxRequests) {
    return false;
  }

  existing.count += 1;
  return true;
}

/**
 * Count the number of non-expired sessions in `sessions` that belong to `ip`.
 *
 * Used by the upload manager to enforce a per-IP concurrent-session cap.
 *
 * @param ip        The client IP address to check.
 * @param sessions  A map of session-id → session metadata (expiresAt ISO string).
 * @returns Number of active (non-expired) sessions for this IP.
 */
export function getActiveSessions(
  ip: string,
  sessions: Map<string, { clientIp: string; expiresAt: string }>,
): number {
  const now = Date.now();
  let count = 0;

  for (const session of sessions.values()) {
    if (session.clientIp === ip && new Date(session.expiresAt).getTime() > now) {
      count += 1;
    }
  }

  return count;
}

/**
 * Pure logic for the Thanks To members pipeline (Stage 1 — scripts only).
 * Kept dependency-free so it can be unit-tested with vitest.
 */

/**
 * Total support per member: sum over each level stay of
 *   level monthly price × months stayed at that level.
 *
 * @param {Array<{ level: string, memberTotalDurationMonths: number }>} levelMonths
 *   `membershipsDurationAtLevel[]` (level = level ID, not display name).
 * @param {Array<{ id: string, price: number }>} levels  levels.json entries.
 * @returns {number} total in the levels' currency.
 */
export function computeTotal(levelMonths, levels) {
  const byId = new Map(levels.map((l) => [l.id, l.price]));
  return (levelMonths ?? []).reduce((sum, entry) => {
    const price = byId.get(entry.level);
    if (price === undefined) return sum; // unknown level → ignore
    return sum + price * (entry.memberTotalDurationMonths ?? 0);
  }, 0);
}

/** Sort members by total (descending); ties keep the original order (stable). */
export function sortByTotal(members) {
  return [...members].sort((a, b) => b.total - a.total);
}

/** True when the given timestamp is older than maxAgeMs (default 7 days). */
export function isStale(fetchedAt, nowMs, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return true; // missing/unparseable → treat as stale
  return nowMs - at > maxAgeMs;
}

/**
 * Compare the cached levels with a fresh `membershipsLevels.list` payload.
 * Order- and key-insensitive: two snapshots are equal when their level sets
 * (id → name/price/currency) match regardless of response ordering.
 *
 * @param {{ levels: unknown[] }} cached  current levels.json.
 * @param {unknown[]} freshItems          `items` from membershipsLevels.list.
 * @returns {boolean} true when nothing changed.
 */
export function levelsUnchanged(cached, freshItems) {
  const norm = (items) => {
    const seen = new Map();
    for (const it of items) {
      if (!it || !it.id) continue;
      // price/currency come either flat ({ id, price, currency }) or nested
      // under monthlyPrice ({ ..., monthlyPrice: { value, currency } }).
      // `typeof it.price === 'number'` distinguishes the flat form; note that
      // a legitimately free level (price: 0) is ambiguous only if the source
      // ever used `undefined` for missing prices — here it falls back to 0
      // either way, so the comparison stays deterministic.
      const price =
        typeof it.price === 'number' ? it.price
        : it.price?.value ?? it.monthlyPrice?.value ?? 0;
      const currency =
        typeof it.currency === 'string' ? it.currency
        : it.currency ?? it.monthlyPrice?.currency ?? null;
      seen.set(it.id, JSON.stringify([it.name ?? it.displayName, price, currency]));
    }
    return new Map([...seen].sort());
  };
  const a = norm(cached?.levels ?? []);
  const b = norm(freshItems ?? []);
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

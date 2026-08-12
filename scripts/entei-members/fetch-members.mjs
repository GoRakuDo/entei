/**
 * Fetch active YouTube members and write the public (secret-free) snapshot
 * used by the Home page.
 *
 * Flow (see docs/THANKS_TO_MEMBERS.md §4):
 *   1. No .secrets/ (CI / GitHub Actions) → print skip, exit 0 (keep committed JSON).
 *   2. members.json fetchedAt within 7 days → print skip, exit 0.
 *   3. OAuth refresh → members.list (paged) + membershipsLevels.list.
 *   4. levels.json cache compare → only rewrite when changed.
 *   5. Compute total (Σ level price × months), sort descending, write members.json.
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './oauth.mjs';
import { computeTotal, sortByTotal, isStale, levelsUnchanged } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const secretsDir = join(__dirname, '.secrets');
const levelsPath = join(__dirname, 'levels.json');
const membersPath = join(
  __dirname, '..', '..', 'apps', 'web', 'src', 'content', 'home', 'members.json',
);

const MEMBERS_URL = 'https://www.googleapis.com/youtube/v3/members';
const LEVELS_URL = 'https://www.googleapis.com/youtube/v3/membershipsLevels';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

async function hasSecrets() {
  try {
    await access(secretsDir, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * GET with a single retry on 401: the access token may have expired between
 * `getAccessToken()` and this request (clock skew / concurrent refresh).
 * Re-fetches a fresh token via the refresh endpoint and retries once.
 */
async function apiGetWithRetry(tokenProvider, url) {
  let token = await tokenProvider();
  const tryOnce = async () => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      token = await tokenProvider(); // force refresh (getAccessToken skips when fresh)
      const retry = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return retry;
    }
    return res;
  };
  const res = await tryOnce();
  if (!res.ok) {
    const text = await res.text();
    const snippet = text.slice(0, 300).replace(/token|secret|refresh_token/gi, '[REDACTED]');
    throw new Error(`GET ${new URL(url).pathname} ${res.status}: ${snippet}`);
  }
  return res.json();
}

/** All members across pages (maxResults=1000 per page). */
async function fetchAllMembers() {
  const members = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ part: 'snippet', mode: 'all_current', maxResults: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    // Each page goes through the 401 single-retry path so a mid-paging
    // token expiry cannot abort the whole run.
    const data = await apiGetWithRetry(getAccessToken, `${MEMBERS_URL}?${params}`);
    members.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return members;
}

/** levels.json payload from membershipsLevels.list items. */
function buildLevels(items) {
  return {
    levels: (items ?? []).map((it) => ({
      id: it.id,
      name: it.snippet?.levelDetails?.displayName ?? null,
      price: it.snippet?.monthlyPrice?.value ?? 0,
      currency: it.snippet?.monthlyPrice?.currency ?? null,
    })),
    fetchedAt: new Date().toISOString(),
  };
}

/** Public member snapshot: { displayName, profileImageUrl, levelName, total }. */
function buildMember(m, levels) {
  const byId = new Map(levels.map((l) => [l.id, l.price]));
  const months = m.membershipsDetails?.membershipsDurationAtLevel ?? [];
  return {
    displayName: m.snippet?.memberDetails?.displayName ?? null,
    profileImageUrl: m.snippet?.memberDetails?.profileImageUrl ?? null,
    levelName: m.snippet?.membershipsDetails?.highestAccessibleLevelDisplayName ?? null,
    total: computeTotal(months, levels),
  };
}

async function main() {
  // 1. CI / no secrets → keep committed JSON.
  if (!(await hasSecrets())) {
    console.log('[fetch-members] no secrets — skipping (GA/CI); using committed members.json');
    return;
  }

  // 2. Fresh snapshot → nothing to do.
  const existing = await readJson(membersPath, null);
  if (existing?.fetchedAt && !isStale(existing.fetchedAt, Date.now(), MAX_AGE_MS)) {
    console.log('up to date; skipping');
    return;
  }

  // 3. Fetch data.
  const [members, levelsData] = await Promise.all([
    fetchAllMembers(),
    apiGetWithRetry(getAccessToken, `${LEVELS_URL}?part=snippet`),
  ]);
  const freshLevels = buildLevels(levelsData.items ?? []);

  // 4. Levels cache: only rewrite when changed.
  const cachedLevels = await readJson(levelsPath, null);
  if (cachedLevels && levelsUnchanged(cachedLevels, levelsData.items ?? [])) {
    console.log('levels unchanged; skipping levels.json');
  } else {
    await writeJson(levelsPath, freshLevels);
    console.log('levels.json updated');
  }
  const levels = freshLevels.levels ?? [];

  // 5-8. Total, sort descending, write public snapshot.
  const sorted = sortByTotal(members.map((m) => buildMember(m, levels)));
  await writeJson(membersPath, {
    fetchedAt: new Date().toISOString(),
    members: sorted,
  });
  console.log(`members.json written (${sorted.length} members)`);
}

main().catch((e) => {
  console.error(`fetch-members failed: ${e.message}`);
  process.exitCode = 1;
});

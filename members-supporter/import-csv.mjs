/**
 * Import a YouTube Studio member CSV export into members.json.
 *
 * Temporary pipeline until the members.list API grant is approved; the
 * script is then replaced by fetch-members.mjs (docs/THANKS_TO_MEMBERS.md).
 *
 * Usage: node members-supporter/import-csv.mjs <path-to-csv>
 *
 * CSV columns (Japanese headers, UTF-8):
 *   メンバー / プロフィールのリンク / 現在のレベル / このレベルでの合計期間（月） / … / 料金
 * Price field form: `"IDR 19,900"` (currency + space + comma-grouped value,
 * may be double-quoted; YouTube uses a no-break space U+00A0).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvLine, parsePrice, extractChannelId, sortByTotal } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const membersPath = join(
  __dirname, '..', 'apps', 'web', 'src', 'content', 'home', 'members.json',
);
const COL_MEMBER = 0;
const COL_PROFILE = 1;
const COL_LEVEL = 2;
const COL_LEVEL_MONTHS = 3;
const COL_PRICE = 8;

async function fetchAvatar(channelId) {
  if (!channelId) return null;
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Matches og:image with any attributes interspersed; YouTube always
    // emits property before content (meta tags stay on one line).
    const m = html.match(/<meta\s+[^>]*property="og:image"[^>]*content="([^"]+)"/);
    const url = m ? m[1] : null;
    return url && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('usage: node members-supporter/import-csv.mjs <path-to-csv>');
    process.exitCode = 1;
    return;
  }

  const raw = await readFile(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // Need the 9 columns (COL_PRICE = 8) so at least 9 elements per row.
  const rows = lines.slice(1).map(parseCsvLine).filter((f) => f.length > COL_PRICE);

  const members = [];
  for (const f of rows) {
    const displayName = f[COL_MEMBER].trim();
    const channelId = extractChannelId(f[COL_PROFILE]);
    const levelName = f[COL_LEVEL].trim();
    const months = Number(f[COL_LEVEL_MONTHS]);
    const price = parsePrice(f[COL_PRICE]);
    const total = price && Number.isFinite(months) ? price.value * months : 0;
    members.push({ displayName, channelId, levelName, months, total, price });
  }

  let avatarOk = 0;
  const withAvatars = [];
  for (const m of members) {
    const profileImageUrl = await fetchAvatar(m.channelId);
    if (profileImageUrl) avatarOk++;
    withAvatars.push({
      displayName: m.displayName,
      profileImageUrl,
      levelName: m.levelName,
      total: m.total,
    });
  }

  const sorted = sortByTotal(withAvatars);
  await mkdir(dirname(membersPath), { recursive: true });
  await writeFile(membersPath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    members: sorted,
  }, null, 2) + '\n');
  console.log(`members.json written (${sorted.length} members)`);
  console.log(`avatars fetched: ${avatarOk}/${sorted.length}`);
}

main().catch((e) => {
  console.error(`import-csv failed: ${e.message}`);
  process.exitCode = 1;
});

/**
 * OAuth 2.0 (desktop-app flow) for the YouTube Data API v3 members scope.
 * Node standard library only — no external dependencies.
 *
 * The redirect URI is FIXED to `http://127.0.0.1:4323/oauth2callback`:
 * the Google Cloud Console OAuth client MUST be configured with that exact
 * redirect URI (or the authorization request will be rejected).
 *
 * Secrets (client.json, token.json) live in `.secrets/` which is gitignored.
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REDIRECT_URI = 'http://127.0.0.1:4323/oauth2callback';
const SCOPE = 'https://www.googleapis.com/auth/youtube.channel-memberships.creator';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const secretsDir = join(__dirname, '.secrets');
export const clientPath = join(secretsDir, 'client.json');
export const tokenPath = join(secretsDir, 'token.json');

async function readJson(path, fallback = null) {
  // Used exactly twice here (client.json / token.json); extract to a shared
  // utils.mjs only if a third call site appears later.
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  // 0600-equivalent: Node's writeFile does not chmod on Windows, but we
  // request mode 0o600 so POSIX hosts keep the file private.
  await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

function openBrowser(url) {
  const platform = process.platform;
  const opener =
    platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    platform === 'darwin' ? ['open', [url]] :
    ['xdg-open', [url]]; // linux
  try {
    const child = spawn(opener[0], opener[1], { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    console.log(`\nOpen this URL in your browser to authorize:\n${url}\n`);
  }
}

/** Exchange an authorization code (and optionally a refresh token) for tokens. */
async function postToken(params) {
  const client = await readJson(clientPath);
  if (!client?.clientId || !client?.clientSecret) {
    throw new Error(`missing OAuth client — expected ${clientPath}`);
  }
  const body = new URLSearchParams({
    ...params,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * First-time consent flow: start a local HTTP server, open the browser,
 * receive the authorization code, exchange it for access + refresh tokens,
 * and persist them to .secrets/token.json.
 */
export async function startAuthFlow() {
  const client = await readJson(clientPath);
  if (!client?.clientId) throw new Error(`missing OAuth client — expected ${clientPath}`);
  const state = randomBytes(16).toString('hex');

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        res.writeHead(400).end(`Authorization failed: ${err}`);
        reject(new Error(`authorization error: ${err}`));
        server.close();
        return;
      }
      // CSRF guard: the callback must echo the state we placed in the URL.
      if (url.searchParams.get('state') !== state) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Authorization failed: state mismatch');
        reject(new Error('authorization error: state mismatch (possible CSRF)'));
        server.close();
        return;
      }
      const codeParam = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Authorized — you can close this window.');
      server.close();
      resolve(codeParam);
    });
    server.on('error', reject);
    server.listen(4323, '127.0.0.1', () => {
      const authUrl = `${AUTH_URL}?${new URLSearchParams({
        client_id: client.clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
      })}`;
      openBrowser(authUrl);
    });
  });

  const tokens = await postToken({
    code,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  await writeJson(tokenPath, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scope: tokens.scope,
  });
  return tokenPath;
}

/** Refresh token → fresh access token; persist and return it. */
export async function refreshAccessToken() {
  const token = await readJson(tokenPath);
  if (!token?.refresh_token) {
    throw new Error(`no refresh token — run \`node oauth.mjs --auth\` first (${tokenPath})`);
  }
  const tokens = await postToken({
    refresh_token: token.refresh_token,
    grant_type: 'refresh_token',
  });
  token.access_token = tokens.access_token;
  token.expires_at = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  await writeJson(tokenPath, token);
  return token.access_token;
}

/** Return a valid access token, refreshing when missing/expired. */
export async function getAccessToken() {
  const token = await readJson(tokenPath);
  if (token?.access_token && token.expires_at && token.expires_at > Date.now() + 60_000) {
    return token.access_token;
  }
  return refreshAccessToken();
}

// CLI entry: node oauth.mjs --auth
// Robust to spaces/odd paths in argv[1]: decide on the flag, not the URL.
const isMainModule =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMainModule && process.argv.includes('--auth')) {
  startAuthFlow()
    .then((p) => console.log(`tokens saved to ${p}`))
    .catch((e) => {
      console.error(`auth flow failed: ${e.message}`);
      process.exitCode = 1;
    });
} else if (isMainModule) {
  console.error('usage: node oauth.mjs --auth');
  process.exitCode = 2;
}

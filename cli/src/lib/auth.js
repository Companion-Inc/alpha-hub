import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const ALPHAXIV_AUTH_ISSUER = 'https://api.alphaxiv.org/auth';
const AUTH_ENDPOINT = `${ALPHAXIV_AUTH_ISSUER}/oauth2/authorize`;
const TOKEN_ENDPOINT = `${ALPHAXIV_AUTH_ISSUER}/oauth2/token`;
const REGISTER_ENDPOINT = `${ALPHAXIV_AUTH_ISSUER}/oauth2/register`;
const CALLBACK_PORT = 9876;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const USERINFO_ENDPOINT = `${ALPHAXIV_AUTH_ISSUER}/oauth2/userinfo`;
const SCOPES = 'openid profile email offline_access';
const LOGIN_TIMEOUT_SECONDS = 300;

function getAuthPath() {
  const dir = join(homedir(), '.ahub');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, 'auth.json');
}

function loadAuth() {
  try {
    return JSON.parse(readFileSync(getAuthPath(), 'utf8'));
  } catch {
    return null;
  }
}

// Write a fresh 0600 file and rename it over auth.json, so readers never see a
// partial file and files created 0644 by older versions are replaced.
function saveAuth(data) {
  const path = getAuthPath();
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function getAccessToken() {
  const auth = loadAuth();
  if (!auth?.access_token) return null;
  return auth.access_token;
}

export function getUserId() {
  const auth = loadAuth();
  return auth?.user_id || null;
}

export function getUserName() {
  const auth = loadAuth();
  return auth?.user_name || null;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function registerClient() {
  const res = await fetch(REGISTER_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Alpha Hub CLI',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!res.ok) throw new Error(`Client registration failed: ${res.status}`);
  return await res.json();
}

function generatePKCE() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function isWsl() {
  return platform() === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function openBrowser(url) {
  try {
    const plat = platform();
    if (plat === 'darwin') execSync(`open "${url}"`);
    else if (isWsl()) {
      // xdg-open usually cannot reach the Windows browser from WSL. rundll32 takes the
      // URL verbatim, unlike `cmd.exe /c start`, which splits it at the first `&`.
      try {
        execSync(`wslview "${url}"`);
      } catch {
        execSync(`rundll32.exe url.dll,FileProtocolHandler "${url}"`);
      }
    }
    // Without a display (SSH, containers) there is no browser to open; the URL is printed.
    else if (plat === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) execSync(`xdg-open "${url}"`);
    else if (plat === 'win32') execSync(`start "" "${url}"`);
  } catch {}
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>alphaXiv</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
  .card { text-align: center; padding: 2rem; }
  h2 { color: #10b981; margin-bottom: 0.5rem; }
  p { color: #737373; }
</style>
</head>
<body><div class="card"><h2>Logged in to alphaXiv</h2><p>You can close this tab</p></div>
<script>setTimeout(function(){window.close()},2000)</script>
</body></html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>alphaXiv</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5; }
  .card { text-align: center; padding: 2rem; }
  h2 { color: #ef4444; margin-bottom: 0.5rem; }
  p { color: #737373; }
</style>
</head>
<body><div class="card"><h2>Login failed</h2><p>You can close this tab and try again</p></div></body></html>`;

function startCallbackServer() {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is already in use. Close the process using it and try again.`));
      } else {
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

// A redirect whose state is not this attempt's is ignored, never allowed to end the login.
function stateMatches(url, expectedState) {
  const returnedState = url.searchParams.get('state');
  return Boolean(returnedState) && returnedState === expectedState;
}

// For a state-matched redirect: the code, or null if there is none. Throws on `?error=`.
function codeFromRedirect(url) {
  const error = url.searchParams.get('error');
  if (error) throw new Error(`OAuth error: ${error}`);
  return url.searchParams.get('code') || null;
}

function parsePastedRedirect(line) {
  const text = line.trim();
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new Error('Not a URL');
  }
  if (url.pathname !== '/callback') throw new Error(`Expected a ${REDIRECT_URI} address`);
  return url;
}

// Resolves with the authorization code from whichever arrives first: the browser
// reaching the loopback callback, or (in a terminal) the redirect URL pasted by a
// user whose browser runs on another machine and cannot reach 127.0.0.1 here.
function waitForCode(server, expectedState) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let rl = null;

    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      rl?.close();
      if (err) reject(err);
      else resolve(code);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Login timed out after ${LOGIN_TIMEOUT_SECONDS} seconds`));
    }, LOGIN_TIMEOUT_SECONDS * 1000);

    server.on('request', (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      let code = null;
      let error = null;
      if (stateMatches(url, expectedState)) {
        try {
          code = codeFromRedirect(url);
        } catch (err) {
          error = err;
        }
      }
      res.writeHead(code ? 200 : 400, { 'Content-Type': 'text/html' });
      res.end(code ? SUCCESS_HTML : ERROR_HTML);
      if (code || error) finish(error, code);
    });

    if (process.stdin?.isTTY) {
      process.stderr.write(
        `If your browser is on another machine, finish logging in there, then paste the\n` +
        `full URL it ends on (${REDIRECT_URI}?code=...) here and press Enter.\n`,
      );
      rl = createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (settled || !line.trim()) return;
        const retry = (message) => process.stderr.write(
          `Could not use that URL: ${message}. Paste the full redirect URL from this login attempt.\n`,
        );
        let url;
        let code;
        try {
          url = parsePastedRedirect(line);
        } catch (err) {
          retry(err.message);
          return;
        }
        if (!stateMatches(url, expectedState)) {
          retry('OAuth state mismatch');
          return;
        }
        try {
          code = codeFromRedirect(url);
        } catch (err) {
          finish(err);
          return;
        }
        if (code) finish(null, code);
        else retry('No authorization code in the redirect URL');
      });
    }
  });
}

async function exchangeCode(code, clientId, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return await res.json();
}

let refreshing = null;

// One refresh at a time per process: refresh tokens rotate, so parallel refreshes
// with the same token would invalidate each other.
export function refreshAccessToken() {
  refreshing ??= refreshTokens().finally(() => { refreshing = null; });
  return refreshing;
}

// If auth.json no longer holds the refresh token we used (logout, or another
// process refreshed or logged in), defer to what is stored rather than overwrite it.
function tokenIfSuperseded(usedRefreshToken) {
  const current = loadAuth();
  if (current?.refresh_token === usedRefreshToken) return undefined;
  return current?.access_token || null;
}

async function refreshTokens() {
  const auth = loadAuth();
  if (!auth?.refresh_token || !auth?.client_id) return null;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token,
    client_id: auth.client_id,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) return tokenIfSuperseded(auth.refresh_token) ?? null;

  const tokens = await res.json();
  const superseded = tokenIfSuperseded(auth.refresh_token);
  if (superseded !== undefined) return superseded;
  saveAuth({
    ...auth,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || auth.refresh_token,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : auth.expires_at,
  });

  return tokens.access_token;
}

export async function login() {
  const registration = await registerClient();
  const clientId = registration.client_id;
  const { verifier, challenge } = generatePKCE();

  const state = randomBytes(16).toString('hex');

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  const server = await startCallbackServer();

  process.stderr.write(`Log in to alphaXiv in your browser. If it doesn't open, visit:\n${authUrl.toString()}\n\n`);
  openBrowser(authUrl.toString());
  const code = await waitForCode(server, state);

  const tokens = await exchangeCode(code, clientId, verifier);

  const userInfo = await fetchUserInfo(tokens.access_token);

  saveAuth({
    client_id: clientId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    user_id: userInfo?.sub || null,
    user_name: userInfo?.name || userInfo?.preferred_username || null,
    user_email: userInfo?.email || null,
  });

  return { tokens, userInfo };
}

export async function getValidToken() {
  let token = getAccessToken();
  if (token) {
    const auth = loadAuth();
    if (auth?.expires_at && Date.now() > auth.expires_at - 60000) {
      token = await refreshAccessToken();
    }
    if (token) return token;
  }
  return null;
}

// Asks alphaXiv whether the stored login still works. Resolves to
// { loggedIn: true, name } or { loggedIn: false, reason: 'missing' | 'expired' };
// throws when alphaXiv cannot be reached or answers unexpectedly.
export async function verifyLogin() {
  if (!getAccessToken()) return { loggedIn: false, reason: 'missing' };
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = attempt === 0 ? await getValidToken() : await refreshAccessToken();
    if (!token) break;
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if ([400, 401, 403].includes(res.status)) continue;
    if (!res.ok) throw new Error(`alphaXiv answered ${res.status} ${res.statusText}`.trim());
    const info = await res.json();
    return { loggedIn: true, name: info?.name || info?.preferred_username || getUserName() };
  }
  return { loggedIn: false, reason: 'expired' };
}

export function isLoggedIn() {
  return !!getAccessToken();
}

export function logout() {
  try {
    saveAuth({});
  } catch {
  }
}

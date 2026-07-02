// OAuth 2.1 + PKCE + Dynamic Client Registration for the Hadron Chrome extension.
//
// This mirrors the flow used by the Hadron CLI (hadron-cli/internal/auth) and the
// macOS app (hadron-macapp OAuthService.swift), adapted to the extension runtime:
//   - The browser leg runs through chrome.identity.launchWebAuthFlow, whose forced
//     redirect target is https://<extension-id>.chromiumapp.org/.
//   - The client_id is obtained once via Dynamic Client Registration and cached.
//   - The resulting `hdr_user_…` bearer token is stored in chrome.storage.local.
//
// All network + identity calls happen in the service worker; the popup never sees
// the token directly, it only asks the worker to sign in / out.

import {
  WELL_KNOWN,
  OAUTH_SCOPE,
  CLIENT_NAME,
  STORAGE_KEYS,
} from './config.js';

// ── storage helpers ─────────────────────────────────────────────────────────

async function storageGet(key) {
  const out = await chrome.storage.local.get(key);
  return out[key];
}

async function storageSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getStoredToken() {
  return (await storageGet(STORAGE_KEYS.token)) || null;
}

export async function clearToken() {
  await chrome.storage.local.remove(STORAGE_KEYS.token);
}

export async function isSignedIn() {
  return Boolean(await getStoredToken());
}

// ── PKCE (S256) ──────────────────────────────────────────────────────────────

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength) {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

async function makePkce() {
  const verifier = randomBase64Url(32); // 43-char verifier
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

// ── discovery ────────────────────────────────────────────────────────────────

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new Error(`${url} → ${res.status} ${res.statusText} ${detail}`.trim());
  }
  return res.json();
}

async function discover() {
  const [as, prm] = await Promise.all([
    fetchJson(WELL_KNOWN.authorizationServer),
    fetchJson(WELL_KNOWN.protectedResource),
  ]);
  if (!as.authorization_endpoint || !as.token_endpoint) {
    throw new Error('Authorization-server metadata is missing endpoints.');
  }
  return {
    authorizationEndpoint: as.authorization_endpoint,
    tokenEndpoint: as.token_endpoint,
    registrationEndpoint: as.registration_endpoint,
    resource: prm.resource,
  };
}

// ── dynamic client registration (cached) ─────────────────────────────────────

function redirectUri() {
  // e.g. https://<extension-id>.chromiumapp.org/
  return chrome.identity.getRedirectURL();
}

async function ensureClientId(registrationEndpoint) {
  const redirect = redirectUri();
  const cached = await storageGet(STORAGE_KEYS.clientRegistration);
  if (cached && cached.redirectUri === redirect && cached.clientId) {
    return cached.clientId;
  }
  if (!registrationEndpoint) {
    throw new Error('Server does not advertise a registration endpoint (DCR).');
  }
  const reg = await fetchJson(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirect],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!reg.client_id) throw new Error('Registration response missing client_id.');
  await storageSet(STORAGE_KEYS.clientRegistration, {
    clientId: reg.client_id,
    redirectUri: redirect,
  });
  return reg.client_id;
}

// ── authorize + token exchange ───────────────────────────────────────────────

async function launchAuthorize({ authorizationEndpoint, clientId, resource }) {
  const redirect = redirectUri();
  const state = randomBase64Url(16);
  const pkce = await makePkce();

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect,
    scope: OAUTH_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  });
  if (resource) params.set('resource', resource);

  const authUrl = `${authorizationEndpoint}?${params.toString()}`;
  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });
  if (!redirectResponse) throw new Error('Authorization was cancelled.');

  const returned = new URL(redirectResponse);
  const err = returned.searchParams.get('error');
  if (err) {
    const desc = returned.searchParams.get('error_description') || '';
    throw new Error(`Authorization failed: ${err} ${desc}`.trim());
  }
  const code = returned.searchParams.get('code');
  const returnedState = returned.searchParams.get('state');
  if (!code) throw new Error('No authorization code returned.');
  if (returnedState !== state) throw new Error('State mismatch — aborting for safety.');

  return { code, verifier: pkce.verifier, redirect };
}

async function exchangeToken({ tokenEndpoint, clientId, code, verifier, redirect, resource }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (resource) body.set('resource', resource);

  const token = await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!token.access_token) throw new Error('Token response missing access_token.');
  return token.access_token;
}

// ── public entry point ───────────────────────────────────────────────────────

/**
 * Runs the full interactive sign-in flow and stores the resulting token.
 * Returns the access token on success; throws on failure/cancellation.
 */
export async function signIn() {
  const meta = await discover();
  const clientId = await ensureClientId(meta.registrationEndpoint);
  const { code, verifier, redirect } = await launchAuthorize({
    authorizationEndpoint: meta.authorizationEndpoint,
    clientId,
    resource: meta.resource,
  });
  const accessToken = await exchangeToken({
    tokenEndpoint: meta.tokenEndpoint,
    clientId,
    code,
    verifier,
    redirect,
    resource: meta.resource,
  });
  await storageSet(STORAGE_KEYS.token, accessToken);
  return accessToken;
}

export async function signOut() {
  await clearToken();
}

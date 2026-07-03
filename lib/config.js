// Static configuration for the Hadron Chrome extension.
//
// The base URL matches the CLI and macOS app (hadron-macapp HadronConfig.swift).
// Everything else (OAuth endpoints, the `resource` URI) is discovered at runtime
// from the well-known metadata documents, so only the base URL is hard-coded.

export const BASE_URL = 'https://srv.hadronmemory.com';

export const GRAPHQL_ENDPOINT = `${BASE_URL}/graphql`;

import { buildResolverUrl } from './urn.js';

// The Hadron portal (web UI). Used to deep-link into nodes/memories from the
// extension's detail view. Mirrors hadron-macapp HadronConfig.portalBaseURL.
export const PORTAL_URL = 'https://hadronmemory.com';

/**
 * Portal deep-link for any entity that has a URN, via the portal's URN
 * resolver (e.g. https://hadronmemory.com/app/u/hrn:node:org::mem::loc).
 * The URN is appended raw (not percent-encoded), matching the portal.
 * Returns null when no URN is available.
 */
export function portalUrlForUrn(urn) {
  if (!urn) return null;
  return buildResolverUrl(PORTAL_URL, urn);
}

/** Portal deep-link fallback from ids when a URN isn't available. */
export function portalUrlForNode(memoryId, nodeId) {
  if (memoryId && nodeId) return `${PORTAL_URL}/app/memories/${memoryId}/nodes/${nodeId}`;
  if (memoryId) return `${PORTAL_URL}/app/memories/${memoryId}`;
  return null;
}

export const WELL_KNOWN = {
  authorizationServer: `${BASE_URL}/.well-known/oauth-authorization-server`,
  protectedResource: `${BASE_URL}/.well-known/oauth-protected-resource`,
};

// OAuth scope requested. The server issues `hdr_user_…` tokens scoped to `mcp`.
export const OAUTH_SCOPE = 'mcp';

export const CLIENT_NAME = 'Hadron Chrome Extension';

// chrome.storage.local keys.
export const STORAGE_KEYS = {
  token: 'hadronToken',
  // DCR client registration, cached keyed by redirect URI.
  clientRegistration: 'hadronClientRegistration',
};

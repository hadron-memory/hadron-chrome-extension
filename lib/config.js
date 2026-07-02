// Static configuration for the Hadron Chrome extension.
//
// The base URL matches the CLI and macOS app (hadron-macapp HadronConfig.swift).
// Everything else (OAuth endpoints, the `resource` URI) is discovered at runtime
// from the well-known metadata documents, so only the base URL is hard-coded.

export const BASE_URL = 'https://srv.hadronmemory.com';

export const GRAPHQL_ENDPOINT = `${BASE_URL}/graphql`;

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

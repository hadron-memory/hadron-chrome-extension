// URN display + linking helpers, mirroring the Hadron portal's
// src/lib/urn/parse-urn.ts (parseDisplayUrn / buildResolverUrl) so URN chips
// render identically to the portal.

export const CANONICAL_SCHEME = 'hrn';

// Narrow display regex (spec-010 types). Matches a canonical `hrn:` or legacy
// `urn:` scheme + a known display type, capturing the bare value after it.
const DISPLAY_URN_REGEX = /^(?:hrn|urn):(org|memory|agent|app|node|user):(.+)$/;

/**
 * Split a URN into { type, bareValue, fullUrn }. Auto-detects the type from a
 * scheme prefix; falls back to `typeHint`, then 'unknown'. `fullUrn` is always
 * reconstructed in canonical `hrn:` form.
 */
export function parseDisplayUrn(value, typeHint) {
  const match = (value || '').match(DISPLAY_URN_REGEX);
  if (match) {
    const type = match[1];
    const bareValue = match[2];
    return { type, bareValue, fullUrn: `${CANONICAL_SCHEME}:${type}:${bareValue}` };
  }
  if (typeHint) {
    return { type: typeHint, bareValue: value, fullUrn: `${CANONICAL_SCHEME}:${typeHint}:${value}` };
  }
  return { type: 'unknown', bareValue: value, fullUrn: `${CANONICAL_SCHEME}:unknown:${value}` };
}

/**
 * Build the shareable portal resolver URL for a URN. The URN is appended
 * **raw** (not percent-encoded) — the portal's `/app/u/[urn]` route is a single
 * path segment and the URN grammar only uses `:`/`::` delimiters plus
 * `[A-Za-z0-9._-]` atoms, all legal in a path segment. Mirrors the portal's
 * buildResolverUrl exactly.
 */
export function buildResolverUrl(baseUrl, urn) {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/app/u/${urn}`;
}

/**
 * Compose a node's fully-qualified URN from its memory URN + loc, mirroring the
 * server's composeNodeUrn (src/lib/urn.ts): `hrn:memory:<bare>` + loc →
 * `hrn:node:<bare>::<loc>`. Lets us render node URN chips before Node.urn ships
 * (hadron-server#481). Returns null when inputs are missing/malformed.
 */
export function composeNodeUrn(memoryUrn, loc) {
  if (!memoryUrn || !loc) return null;
  const canonical = memoryUrn.replace(/^urn:/, `${CANONICAL_SCHEME}:`);
  const prefix = `${CANONICAL_SCHEME}:memory:`;
  if (!canonical.startsWith(prefix)) return null;
  const bare = canonical.slice(prefix.length);
  return `${CANONICAL_SCHEME}:node:${bare}::${loc}`;
}

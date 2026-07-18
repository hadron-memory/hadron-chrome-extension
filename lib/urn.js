// URN display + linking helpers, mirroring the Hadron portal's
// src/lib/urn/parse-urn.ts (parseDisplayUrn / buildResolverUrl) so URN chips
// render identically to the portal.

export const CANONICAL_SCHEME = 'hrn';

// Registered display kinds (spec-010), plus the grammar-v2 `mem` type word the
// server now emits for memories (hadron-server #720). Matches a canonical
// `hrn:` or legacy `urn:` scheme + a known display type, capturing the bare
// value after it. Built to mirror urn-lib-js `display.ts` + the portal's
// Urn.svelte so chips render identically.
const DISPLAY_TYPES = ['org', 'memory', 'mem', 'agent', 'app', 'node', 'user', 'apprun'];
// Case-insensitive to match hasSchemePrefix: an upper/mixed-case scheme like
// `HRN:mem:...` must match here (and get its type lowercased below) rather than
// fall through to the scheme-prefixed `unknown` branch.
const DISPLAY_URN_REGEX = new RegExp(`^(?:hrn|urn):(${DISPLAY_TYPES.join('|')}):(.+)$`, 'i');

/** True when the value carries a URN scheme prefix (`hrn:` or `urn:`). */
function hasSchemePrefix(value) {
  return /^(?:hrn|urn):/i.test(value || '');
}

/**
 * Split a URN into { type, bareValue, fullUrn }. Auto-detects the type from a
 * scheme prefix; falls back to `typeHint`, then 'unknown'. `fullUrn` is always
 * reconstructed in canonical `hrn:` form.
 *
 * Grammar-v2 rendering (mirrors the portal): the `memory` kind renders under
 * the v2 `mem` type word, and legacy `::` hierarchy separators collapse to the
 * v2 single colon — so a chip built from a stale v1 URN still shows the flat
 * v2 form the server now emits and the portal now renders.
 */
export function parseDisplayUrn(value, typeHint) {
  const v = value || '';
  const match = v.match(DISPLAY_URN_REGEX);
  if (match) {
    const rawType = match[1].toLowerCase();
    const type = rawType === 'memory' ? 'mem' : rawType;
    const bareValue = match[2].replaceAll('::', ':');
    return { type, bareValue, fullUrn: `${CANONICAL_SCHEME}:${type}:${bareValue}` };
  }
  // Apply a type hint only to a bare (scheme-less) value. Hinting a
  // scheme-prefixed URN whose kind is unregistered would double-prefix it
  // (`hrn:<hint>:hrn:<kind>:...`) and mislabel the chip; let those fall through
  // to `unknown` so the missing display registration stays visible.
  if (typeHint && !hasSchemePrefix(v)) {
    const type = typeHint === 'memory' ? 'mem' : typeHint;
    const bareValue = v.replaceAll('::', ':');
    return { type, bareValue, fullUrn: `${CANONICAL_SCHEME}:${type}:${bareValue}` };
  }
  return { type: 'unknown', bareValue: v, fullUrn: `${CANONICAL_SCHEME}:unknown:${v}` };
}

/**
 * Build the shareable portal resolver URL for a URN. The URN is appended
 * **raw** (not percent-encoded) — the portal's `/app/u/[urn]` route is a single
 * path segment and the flat grammar-v2 URN only uses `:` delimiters plus
 * `[A-Za-z0-9._-]` atoms, all legal in a path segment. Mirrors the portal's
 * buildResolverUrl exactly.
 */
export function buildResolverUrl(baseUrl, urn) {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/app/u/${urn}`;
}

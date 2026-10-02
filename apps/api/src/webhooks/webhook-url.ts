import { ApiError } from '../common/errors/api-error';

/**
 * DI token for the optional destination allow/deny lists (D13). Declared here,
 * next to {@link DestinationPolicy}, because the policy is enforced in **two**
 * places that both need it: registration (`WebhooksService`, rejecting a new
 * endpoint) and delivery (`WebhookDeliveryService`, re-checking a stored one).
 */
export const WEBHOOK_DESTINATIONS = 'WEBHOOK_DESTINATIONS';

/**
 * Webhook destination URL rules (phase 10 §4.6, §5.7 D13).
 *
 * A registered destination becomes an **outbound** HTTP request made by
 * BrinnPay, so the URL is validated once at the boundary and then stored
 * normalized. Validation is deliberately about well-formedness, not about
 * *where* the URL points: the sandbox's purpose requires delivering to
 * `localhost`, container names and tunnel URLs, so private, loopback and
 * link-local destinations are allowed by default (D13). The compensating
 * controls are in §5.7 — no redirect following, bounded timeouts, no credential
 * forwarding, sanitized logs, and tenant isolation — plus the optional
 * allow/deny list that a deployment can configure.
 */

/** Maximum stored/delivered URL length (§4.6). */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Normalized absolute `http`/`https` URL, or a 400 field error. */
export type ValidatedWebhookUrl = string;

/**
 * The optional destination allow/deny lists of D13. Both default to empty, which
 * means "no restriction" — the posture a sandbox needs, since a developer must be
 * able to receive on `localhost`, a container name, or a tunnel URL.
 */
export interface DestinationPolicy {
  allowlist?: readonly string[];
  denylist?: readonly string[];
}

/**
 * Reduces a host to the single form an operator writes in configuration.
 *
 * WHATWG URL keeps IPv6 literals bracketed and preserves an explicit FQDN root
 * dot, so `new URL('http://[::1]/h').hostname` is `"[::1]"` and
 * `new URL('http://localhost./h').hostname` is `"localhost."`. Both are the same
 * host as the `::1` and `localhost` an operator puts in a denylist. Comparing
 * the raw strings therefore misses exactly the canonical spellings of a loopback
 * address and an FQDN root — which would make a denylist silently fail to deny
 * the hosts it names, in the one direction that matters. Normalizing **both**
 * sides keeps the comparison an exact host match while making the list mean what
 * it says.
 */
export function canonicalizeWebhookHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  // Brackets are URL syntax, not part of the address.
  const unbracketed =
    trimmed.length > 2 && trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
  // A single trailing dot is the explicit FQDN root; `example.com.` and
  // `example.com` resolve identically.
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;
}

/**
 * Applies the optional destination policy (D13) to a **validated, normalized** URL.
 * Matching is an exact, case-insensitive host comparison after
 * {@link canonicalizeWebhookHost} on both sides: an allowlist is a deliberate
 * deployment control, not a pattern language, and a permissive default must not
 * turn into an accidental prefix match (`evil.example.com` matching
 * `example.com`).
 *
 * The allowlist wins when both are set, so a deployment can open one known host
 * inside a broader denial. Private, loopback, and link-local hosts are **not**
 * rejected here — that is the confirmed default (D13); the compensating controls
 * are no redirect following, bounded timeouts, no credential forwarding, sanitized
 * logs, and tenant isolation (§5.7).
 *
 * Matching is exact per host, so denying `internal.example.com` does not deny
 * `evil.internal.example.com`. That is a deliberate limit of a list that is not a
 * pattern language; ADR-0019 records it, and suffix matching is a hardened-mode
 * concern rather than a v1 default.
 */
export function assertDestinationAllowed(
  url: ValidatedWebhookUrl,
  policy: DestinationPolicy | undefined,
): void {
  if (!policy || (policy.allowlist?.length ?? 0) === 0 && (policy.denylist?.length ?? 0) === 0) {
    return;
  }

  const host = canonicalizeWebhookHost(new URL(url).hostname);
  const allowlist = (policy.allowlist ?? []).map(canonicalizeWebhookHost);

  if (allowlist.length > 0) {
    if (!allowlist.includes(host)) {
      throw urlError('URL host is not in the configured webhook destination allowlist');
    }
    return;
  }
  if ((policy.denylist ?? []).map(canonicalizeWebhookHost).includes(host)) {
    throw urlError('URL host is in the configured webhook destination denylist');
  }
}

/**
 * Validates and normalizes a destination URL.
 *
 * Rejected with a 400 `VALIDATION_ERROR` carrying a `url` field entry when the
 * value is not an absolute `http`/`https` URL with a host, embeds credentials
 * in the authority, carries a fragment, or exceeds {@link MAX_WEBHOOK_URL_LENGTH}.
 *
 * Normalization is intentionally minimal so the stored value is what the
 * developer registered and what is delivered to: the scheme and host are
 * lowercased (both case-insensitive per RFC 3986) and a single trailing `/` is
 * stripped from an otherwise empty path. The path, query, port, and every other
 * component are left byte-for-byte intact — normalizing them would change the
 * identity of the endpoint.
 */
export function validateWebhookUrl(
  raw: unknown,
  policy?: DestinationPolicy,
): ValidatedWebhookUrl {
  if (typeof raw !== 'string') {
    throw urlError('URL must be an http or https URL');
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw urlError('URL must not be empty');
  }
  if (trimmed.length > MAX_WEBHOOK_URL_LENGTH) {
    throw urlError(`URL must be at most ${MAX_WEBHOOK_URL_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw urlError('URL must be an absolute http or https URL');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw urlError('URL must use the http or https scheme');
  }
  if (parsed.hostname.length === 0) {
    throw urlError('URL must include a host');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    // Credentials in the authority would be stored at rest and would travel to
    // the destination; BrinnPay never forwards credentials (§5.7).
    throw urlError('URL must not embed credentials');
  }
  if (parsed.hash.length > 0) {
    // A fragment is never transmitted, so accepting it would store a value that
    // can never be reached and would make the delivered URL differ from the
    // registered one.
    throw urlError('URL must not contain a fragment');
  }

  const normalized = normalizeWebhookUrl(parsed);
  assertDestinationAllowed(normalized, policy);
  return normalized;
}

/** Applies the minimal normalization described on {@link validateWebhookUrl}. */
export function normalizeWebhookUrl(parsed: URL): ValidatedWebhookUrl {
  const normalized = new URL(parsed.toString());
  normalized.protocol = parsed.protocol.toLowerCase();
  normalized.hostname = parsed.hostname.toLowerCase();

  // `http://host` and `http://host/` address the same resource; collapse only
  // that exact difference and leave every other path untouched. The WHATWG URL
  // serializer always emits the root path as `/`, so the single slash is removed
  // from the final string instead of through `pathname`.
  const serialized = normalized.toString();
  const isRootResource = normalized.pathname === '/' && normalized.search === '' && normalized.hash === '';
  return isRootResource && serialized.endsWith('/') ? serialized.slice(0, -1) : serialized;
}

function urlError(message: string): ApiError {
  return ApiError.validation({ fields: [{ field: 'url', errors: [message] }] });
}

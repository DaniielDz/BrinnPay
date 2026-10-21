import { BlockList, isIP } from 'node:net';

/**
 * Discriminator resolution and normalization (phase 13 §4.2 rule 1, D1).
 *
 * Two things live here, and nothing else in the capability:
 *
 * 1. **Client identity** — which client a request belongs to, under an explicit
 *    env-driven proxy trust model. Behind a load balancer every client shares
 *    the socket peer (a functional failure); trusting `X-Forwarded-For` blindly
 *    lets a caller mint unlimited buckets (a security failure). Both are avoided
 *    by trusting forwarded headers **only** from a configured, bounded proxy, and
 *    only after a walk that a client cannot steer.
 * 2. **Normalization** — the canonical text form of a discriminator before it is
 *    hashed, so one client cannot obtain several budgets by varying the textual
 *    form of its address or email.
 *
 * A resolved discriminator is never logged, stored or returned: it is hashed by
 * `rate-limit-counter.service.ts` before it reaches Redis (§8).
 *
 * One configuration rule is load-bearing and enforced at boot: **a hop count
 * requires an allowlist.** `X-Forwarded-For` is written by the client up to the
 * first proxy, so without an allowlist the entry the limiter reads is the entry
 * the caller chose.
 */

/** How a deployment asserts which proxies may speak for a client (D1). */
export interface ProxyTrust {
  /**
   * Bounded hop count read out of `X-Forwarded-For`. `0` disables trusting
   * forwarded headers entirely.
   */
  readonly hops: number;
  /**
   * CIDR allowlist of proxies. Mandatory whenever {@link hops} is positive: a hop
   * count bounds how much of the chain is read, and only the allowlist decides
   * who is allowed to write it. Boot refuses the combination.
   */
  readonly cidrs: readonly string[];
}

/** One hextet of an IPv6 address, in hex, one to four digits. */
const IPV6_GROUP = /^[0-9a-f]{1,4}$/;

/** The slice of an Express request this module may read. */
export interface ClientIdentityRequest {
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string | undefined };
}

/**
 * Splits an IPv6 address into its eight 16-bit groups, or returns `null`.
 *
 * `::` stands for one or more zero groups, and a trailing dotted quad stands for
 * the last two groups — the two places where the same address has several
 * spellings.
 */
function parseIpv6Groups(value: string): number[] | null {
  const halves = value.split('::');
  if (halves.length > 2) {
    return null;
  }

  const parseGroups = (part: string): number[] | null => {
    if (part.length === 0) {
      return [];
    }
    const pieces = part.split(':');
    const groups: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index] as string;
      if (piece.includes('.')) {
        // A dotted quad is only legal as the last piece, and always fills exactly
        // two groups (`::ffff:1.2.3.4` is `…0xffff:102:304`).
        if (index !== pieces.length - 1) {
          return null;
        }
        const octets = piece.split('.');
        if (octets.length !== 4) {
          return null;
        }
        const bytes: number[] = [];
        for (const octet of octets) {
          if (!/^\d{1,3}$/.test(octet)) {
            return null;
          }
          const byte = Number(octet);
          if (byte > 255) {
            return null;
          }
          bytes.push(byte);
        }
        groups.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
        continue;
      }
      if (!IPV6_GROUP.test(piece)) {
        return null;
      }
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? parseGroups(halves[1] ?? '') : [];
  if (head === null || tail === null) {
    return null;
  }

  if (halves.length === 2) {
    const gap = 8 - head.length - tail.length;
    return gap >= 1 ? [...head, ...new Array<number>(gap).fill(0), ...tail] : null;
  }
  return head.length === 8 ? head : null;
}

/**
 * Serializes eight groups in RFC 5952 form: lowercase, no leading zeros, and the
 * **leftmost longest** run of zero groups of two or more replaced by `::`.
 */
function serializeIpv6Groups(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      runStart = runStart === -1 ? index : runStart;
      continue;
    }
    if (runStart !== -1) {
      if (index - runStart > bestLength) {
        bestStart = runStart;
        bestLength = index - runStart;
      }
      runStart = -1;
    }
  }

  const head = groups.slice(0, bestLength >= 2 ? bestStart : groups.length);
  if (bestLength < 2) {
    return head.map((group) => group.toString(16)).join(':');
  }
  const tail = groups.slice(bestStart + bestLength);
  return `${head.map((group) => group.toString(16)).join(':')}::${tail
    .map((group) => group.toString(16))
    .join(':')}`;
}

/**
 * The canonical text form of an IPv6 address, or `null` when it cannot be parsed.
 *
 * The IPv4-mapped range is rendered as the IPv4 address it embeds, so every
 * spelling of a mapped address collapses to one string in one step — including
 * the expanded form (`0:0:0:0:0:ffff:1.2.3.4`) that a prefix comparison misses.
 */
function canonicalizeIpv6(value: string): string | null {
  const groups = parseIpv6Groups(value);
  if (!groups) {
    return null;
  }

  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return serializeIpv6Groups(groups);
}

/**
 * Canonicalizes a client identity (D1): an IPv4 address as written, and an IPv6
 * address re-serialized in RFC 5952 form with an embedded IPv4-mapped address
 * collapsed to its IPv4. Without this a single client could hold several budgets
 * by varying the textual form of its address — `::ffff:1.2.3.4` /
 * `0:0:0:0:0:ffff:1.2.3.4` / `1.2.3.4`, or `2001:db8::1` /
 * `2001:0db8:0000:0000:0000:0000:0000:0001` / `2001:db8:0:0:0:0:0:1`.
 *
 * Zone identifiers (`fe80::1%eth0`) and brackets are removed first: they are
 * local to one interface and only ever appear in a header value. An address that
 * cannot be canonicalized returns the empty string, which the enforcement point
 * reads as "share one bounded budget" — a spelling this module fails to
 * understand must never become a fresh budget.
 */
export function normalizeClientIdentity(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (value.length === 0) {
    return '';
  }

  const zone = value.indexOf('%');
  if (zone !== -1) {
    value = value.slice(0, zone);
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }

  if (isIP(value) === 6) {
    return canonicalizeIpv6(value) ?? '';
  }
  return value;
}

/**
 * Canonicalizes the account discriminator: the same trim/lowercase rule the auth
 * module applies to an email before it stores or compares one, so
 * `someone@example.com` and ` Someone@Example.com ` cannot hold two budgets.
 */
export function normalizeAccountDiscriminator(email: string): string {
  return email.trim().toLowerCase();
}

function compileAllowlist(cidrs: readonly string[]): BlockList | null {
  if (cidrs.length === 0) {
    return null;
  }
  // The allowlist comes from configuration and therefore never changes at
  // runtime, so it is compiled once and reused: this sits on the request path.
  const signature = JSON.stringify(cidrs);
  if (signature === cachedAllowlistSignature) {
    return cachedAllowlist;
  }

  const blockList = new BlockList();
  for (const entry of cidrs) {
    const separator = entry.lastIndexOf('/');
    const address = separator === -1 ? entry : entry.slice(0, separator);
    const prefix =
      separator === -1 ? (isIP(address) === 4 ? 32 : 128) : Number(entry.slice(separator + 1));
    const family: 'ipv4' | 'ipv6' = isIP(address) === 4 ? 'ipv4' : 'ipv6';
    blockList.addSubnet(address, prefix, family);
  }

  cachedAllowlistSignature = signature;
  cachedAllowlist = blockList;
  return blockList;
}

let cachedAllowlistSignature: string | null = null;
let cachedAllowlist: BlockList | null = null;

/**
 * Splits `X-Forwarded-For` into its entries **exactly as written**, discarding
 * nothing — not even the empty tokens a trailing or doubled comma leaves behind.
 *
 * Filtering here would be a security defect, not a convenience: dropping an
 * entry shifts every position in the chain, so a caller who writes a
 * non-address as the rightmost entry moves the walk's window onto an entry it
 * chose. The unparseable entries are inspected and rejected explicitly instead.
 */
function forwardedChain(headers: Record<string, unknown> | undefined): string[] {
  const raw = headers?.['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }
  return value.split(',').map((entry) => entry.trim());
}

/**
 * Can this entry be read as a single address? `normalizeClientIdentity` accepts
 * the bracketed and zone-qualified spellings a proxy may append, and returns the
 * text unchanged when it is not an address — so `isIP` on the result is the test.
 */
function isAddressEntry(entry: string): boolean {
  return isIP(normalizeClientIdentity(entry)) !== 0;
}

/** The direct socket peer: the only client identity available without trust. */
function socketPeer(request: ClientIdentityRequest): string {
  return request.socket?.remoteAddress ?? '';
}

/** Is this address one of the proxies the deployment has vouched for? */
function isTrustedProxy(address: string, allowlist: BlockList): boolean {
  const version = isIP(address);
  return version !== 0 && allowlist.check(address, version === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Resolves the client identity under the configured trust model (D1).
 *
 * - **No proxy configured** (`hops === 0`, or no allowlist) → the direct socket
 *   peer. Forwarded headers from any source are ignored for limit purposes, so a
 *   caller cannot forge its bucket by sending `X-Forwarded-For` to a directly
 *   exposed deployment.
 * - **Configured** → the socket peer must itself be inside the allowlist before
 *   any forwarded entry is read; otherwise the peer is the identity.
 *
 * The chain is then walked **right to left** and the first entry that is *not* a
 * trusted proxy is returned. That direction is what makes the walk unforgeable: a
 * client can only add entries to the **left** of its real address, so padding the
 * header cannot move the walk's answer onto an attacker-chosen value the way a
 * positional index could. `hops` caps how far left the walk is allowed to look;
 * when every inspected entry is itself a trusted proxy, the leftmost inspected
 * entry is used, which is the only answer available in that case.
 *
 * Two rules keep that reasoning true when entries do not parse:
 *
 * - the **rightmost** entry must be an address, or the chain is not read at all
 *   (a caller that writes the rightmost entry controls whatever sits next to it);
 * - a non-address inside the window is skipped, never returned as an identity.
 *
 * Forwarded headers are honored only when the trusted proxy *appends* to the
 * chain; a proxy that forwards the caller's header unchanged cannot be
 * distinguished from a caller, so nothing in this path can recover a client
 * identity from it.
 */
export function resolveClientIdentity(request: ClientIdentityRequest, trust: ProxyTrust): string {
  const peer = normalizeClientIdentity(socketPeer(request));
  const allowlist = compileAllowlist(trust.cidrs);

  // A hop count without an allowlist would read an entry the client wrote. Boot
  // refuses that combination (D1); refusing it here too keeps a hand-built trust
  // object from re-opening it.
  if (trust.hops <= 0 || allowlist === null) {
    return peer;
  }

  if (!isTrustedProxy(peer, allowlist)) {
    // The socket peer is not a configured proxy: the chain is attacker-written.
    return peer;
  }

  const chain = forwardedChain(request.headers);
  if (chain.length === 0) {
    return peer;
  }

  // The rightmost entry is the one the trusted proxy appended. If it is not an
  // address, this chain is not a record of what a proxy appended — a caller can
  // write the rightmost entry itself — so the forwarded headers are not read.
  if (!isAddressEntry(chain[chain.length - 1] as string)) {
    return peer;
  }

  const inspected = chain.slice(-trust.hops);
  for (let index = inspected.length - 1; index >= 0; index -= 1) {
    const entry = inspected[index] as string;
    if (!isAddressEntry(entry)) {
      // Only the caller can write a non-address, and it is always left of the
      // entry the proxy appended, so it is padding: skipped, never returned as
      // an identity.
      continue;
    }
    const candidate = normalizeClientIdentity(entry);
    if (!isTrustedProxy(candidate, allowlist)) {
      return candidate;
    }
  }

  const leftmost = inspected[0] as string;
  return isAddressEntry(leftmost) ? normalizeClientIdentity(leftmost) : '';
}
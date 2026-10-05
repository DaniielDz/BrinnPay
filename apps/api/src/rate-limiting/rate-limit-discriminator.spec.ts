import {
  normalizeAccountDiscriminator,
  normalizeClientIdentity,
  resolveClientIdentity,
  type ClientIdentityRequest,
  type ProxyTrust,
} from './rate-limit-discriminator';

/**
 * Client identity and proxy trust (phase 13 D1, §8).
 *
 * Two failure modes are being closed here, and they pull in opposite directions:
 * behind a load balancer every client shares the socket peer (a functional
 * failure), while trusting `X-Forwarded-For` blindly lets a caller mint unlimited
 * buckets (a security failure). The trust model is therefore explicit, bounded,
 * and structured so that a client cannot steer it.
 */
describe('client identity resolution (phase 13 D1)', () => {
  const NO_TRUST: ProxyTrust = { hops: 0, cidrs: [] };
  const ONE_PROXY: ProxyTrust = { hops: 1, cidrs: ['10.0.0.0/8'] };
  const TWO_HOPS: ProxyTrust = { hops: 2, cidrs: ['10.0.0.0/8'] };
  const THREE_HOPS: ProxyTrust = { hops: 3, cidrs: ['10.0.0.0/8'] };
  const TWO_NETWORKS: ProxyTrust = { hops: 1, cidrs: ['10.0.0.0/8', '172.16.0.0/12'] };
  const PROXY_PEER = '10.0.0.1';
  const CLIENT = '203.0.113.7';

  function requestFrom(options: {
    peer?: string;
    forwardedFor?: string;
  }): ClientIdentityRequest {
    return {
      headers: options.forwardedFor === undefined ? {} : { 'x-forwarded-for': options.forwardedFor },
      socket: { remoteAddress: options.peer ?? PROXY_PEER },
    };
  }

  describe('normalization', () => {
    it('collapses an IPv4-mapped IPv6 address to its IPv4 form', () => {
      expect(normalizeClientIdentity('::ffff:192.168.1.10')).toBe('192.168.1.10');
      expect(normalizeClientIdentity('::FFFF:192.168.1.10')).toBe('192.168.1.10');
      expect(normalizeClientIdentity('[::ffff:192.168.1.10]')).toBe('192.168.1.10');
    });

    it('collapses the expanded form of an IPv4-mapped address too', () => {
      // A prefix comparison misses this one: the mapped prefix is spelled out in
      // full, and each spelling would otherwise be its own budget.
      expect(normalizeClientIdentity('0:0:0:0:0:ffff:192.168.1.10')).toBe('192.168.1.10');
      expect(normalizeClientIdentity('0:0:0:0:0:FFFF:C0A8:010A')).toBe('192.168.1.10');
      expect(normalizeClientIdentity('::ffff:c0a8:010a')).toBe('192.168.1.10');
    });

    it('serializes every IPv6 spelling of one address identically (RFC 5952)', () => {
      const spellings = [
        '2001:db8::1',
        '2001:0db8:0000:0000:0000:0000:0000:0001',
        '2001:db8:0:0:0:0:0:1',
        '2001:DB8::1',
        '2001:db8:0::1',
      ];
      const identities = new Set(spellings.map(normalizeClientIdentity));
      expect(identities.size).toBe(1);
      expect([...identities][0]).toBe('2001:db8::1');
    });

    it('applies RFC 5952 compression rules, including the leftmost longest run', () => {
      expect(normalizeClientIdentity('::')).toBe('::');
      expect(normalizeClientIdentity('0:0:0:0:0:0:0:0')).toBe('::');
      expect(normalizeClientIdentity('::1')).toBe('::1');
      expect(normalizeClientIdentity('1::')).toBe('1::');
      expect(normalizeClientIdentity('fe80::1')).toBe('fe80::1');
      expect(normalizeClientIdentity('1:0:0:2:0:0:0:3')).toBe('1:0:0:2::3');
      // Two runs of equal length: the leftmost is compressed.
      expect(normalizeClientIdentity('1:0:0:2:0:0:3:4')).toBe('1::2:0:0:3:4');
      // A single zero group is never compressed.
      expect(normalizeClientIdentity('1:2:3:4:5:6:0:8')).toBe('1:2:3:4:5:6:0:8');
      expect(normalizeClientIdentity('1:2:3:4:5:6:7:8')).toBe('1:2:3:4:5:6:7:8');
      expect(normalizeClientIdentity('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1');
    });

    it('keeps a non-mapped IPv4-embedded address in IPv6 form', () => {
      // Outside `::ffff:0:0/96` a dotted quad is not an embedded IPv4 address, so
      // rendering one as four octets would invent a different client.
      expect(normalizeClientIdentity('::1.2.3.4')).toBe('::102:304');
      expect(normalizeClientIdentity('2001:db8::1.2.3.4')).toBe('2001:db8::102:304');
      expect(normalizeClientIdentity('2001:db8::1.2.3.4')).not.toBe(
        normalizeClientIdentity('2001:db8::1.2.3'),
      );
    });

    it('treats the whole ::ffff:0:0/96 range as mapped', () => {
      // `::ffff:0:102` is `::ffff:0.0.1.2`: the mapped range is the first 96 bits,
      // so this is the same address spelled without the dotted quad.
      expect(normalizeClientIdentity('::ffff:0:102')).toBe('0.0.1.2');
    });

    it('strips zone identifiers and brackets', () => {
      expect(normalizeClientIdentity('FE80::1')).toBe('fe80::1');
      expect(normalizeClientIdentity('[fe80::1]')).toBe('fe80::1');
      expect(normalizeClientIdentity('fe80::1%eth0')).toBe('fe80::1');
      expect(normalizeClientIdentity('  192.168.1.10  ')).toBe('192.168.1.10');
    });

    it('gives one client exactly one identity across textual variants', () => {
      const variants = [
        '192.168.1.10',
        '::ffff:192.168.1.10',
        '0:0:0:0:0:ffff:192.168.1.10',
        '[::FFFF:192.168.1.10]',
        ' 192.168.1.10 ',
      ];
      const identities = new Set(variants.map(normalizeClientIdentity));
      expect(identities.size).toBe(1);
    });

    it('returns the empty string for an unusable value rather than throwing', () => {
      expect(normalizeClientIdentity('')).toBe('');
      expect(normalizeClientIdentity('   ')).toBe('');
      // Not an address at all: nothing is canonicalized, and nothing is invented.
      expect(normalizeClientIdentity('not-an-ip')).toBe('not-an-ip');
    });

    it('normalizes the account discriminator the way auth normalizes an email', () => {
      expect(normalizeAccountDiscriminator('  Someone@Example.COM ')).toBe('someone@example.com');
      expect(normalizeAccountDiscriminator('someone@example.com')).toBe(
        normalizeAccountDiscriminator('SOMEONE@EXAMPLE.COM'),
      );
    });
  });

  describe('trust model', () => {
    it('uses the socket peer and ignores forwarded headers when nothing is trusted', () => {
      // The directly exposed case: a forged header must not buy a new bucket.
      expect(
        resolveClientIdentity(
          requestFrom({ peer: '203.0.113.7', forwardedFor: '1.2.3.4, 5.6.7.8' }),
          NO_TRUST,
        ),
      ).toBe('203.0.113.7');
    });

    it('ignores forwarded headers when a hop count has no allowlist to go with', () => {
      // Defense in depth for the boot-time rule: a hop count on its own would read
      // an entry the client wrote, so the peer wins.
      expect(
        resolveClientIdentity(
          requestFrom({ peer: PROXY_PEER, forwardedFor: '1.1.1.1' }),
          { hops: 1, cidrs: [] },
        ),
      ).toBe(PROXY_PEER);
      expect(
        resolveClientIdentity(
          requestFrom({ peer: PROXY_PEER, forwardedFor: '1.1.1.1' }),
          { hops: 5, cidrs: [] },
        ),
      ).toBe(PROXY_PEER);
    });

    it('honours one trusted hop behind a proxy', () => {
      expect(resolveClientIdentity(requestFrom({ forwardedFor: CLIENT }), ONE_PROXY)).toBe(CLIENT);
    });

    it('walks the trusted chain outwards from the socket peer', () => {
      // Chain: client -> proxy1 (10.9.9.9) -> proxy2, socket peer proxy2 (10.0.0.1).
      const chain = { forwardedFor: `${CLIENT}, 10.9.9.9` };
      expect(resolveClientIdentity(requestFrom(chain), ONE_PROXY)).toBe('10.9.9.9');
      expect(resolveClientIdentity(requestFrom(chain), TWO_HOPS)).toBe(CLIENT);

      const deeper = { forwardedFor: `${CLIENT}, 10.9.9.9, 10.8.8.8` };
      expect(resolveClientIdentity(requestFrom(deeper), TWO_HOPS)).toBe('10.9.9.9');
      expect(resolveClientIdentity(requestFrom(deeper), THREE_HOPS)).toBe(CLIENT);
    });

    it('resists a client that prepends forged entries to the chain', () => {
      // A positional index would land on `7.7.7.7` here; the right-to-left walk
      // cannot, because the client only ever adds entries to the *left*.
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: '6.6.6.6, 7.7.7.7, 203.0.113.77' }), THREE_HOPS),
      ).toBe('203.0.113.77');
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: '6.6.6.6, 203.0.113.77, 10.9.9.9' }), THREE_HOPS),
      ).toBe('203.0.113.77');
    });

    it('resists a client padding the chain beyond the real proxy depth', () => {
      // hops says three, the real depth is one: the walk inspects three entries
      // and still answers with the rightmost untrusted one.
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: '1.1.1.1, 2.2.2.2, 203.0.113.9' }), THREE_HOPS),
      ).toBe('203.0.113.9');
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9' }), THREE_HOPS),
      ).toBe('203.0.113.9');
    });

    it('ignores prepended entries beyond the hop count entirely', () => {
      // One trusted hop: only the entry the nearest proxy appended is inspected, so
      // padding the header buys nothing.
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: '1.1.1.1, 2.2.2.2, 3.3.3.3' }), ONE_PROXY),
      ).toBe('3.3.3.3');
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: '1.1.1.1, 2.2.2.2, 203.0.113.9' }), ONE_PROXY),
      ).toBe('203.0.113.9');
    });

    it('falls back to the socket peer when the trusted hop carries no chain', () => {
      expect(resolveClientIdentity(requestFrom({}), ONE_PROXY)).toBe(PROXY_PEER);
      expect(resolveClientIdentity(requestFrom({ forwardedFor: '   ' }), ONE_PROXY)).toBe(PROXY_PEER);
    });

    it('falls back to the leftmost inspected entry when every entry is a proxy', () => {
      // Nothing in the chain identifies a client: the leftmost inspected entry is the
      // only answer, and the hop count bounds how far left that answer may come from.
      const chain = { forwardedFor: '10.1.1.1, 10.2.2.2' };
      expect(resolveClientIdentity(requestFrom(chain), ONE_PROXY)).toBe('10.2.2.2');
      expect(resolveClientIdentity(requestFrom(chain), TWO_HOPS)).toBe('10.1.1.1');
    });

    it('ignores unparseable chain entries instead of failing open on them', () => {
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: 'unknown, 203.0.113.7' }), ONE_PROXY),
      ).toBe('203.0.113.7');
      expect(resolveClientIdentity(requestFrom({ forwardedFor: 'unknown' }), ONE_PROXY)).toBe(
        PROXY_PEER,
      );
    });

    it('refuses to read a chain whose rightmost entry is not an address', () => {
      // The rightmost entry is the one the trusted proxy appended. When it does not
      // parse, the caller wrote it — and dropping it would shift the walk onto the
      // caller's own padding, handing over the identity. Falling back to the socket
      // peer is bounded; a forwarded claim here would be unlimited.
      for (const forged of [
        `${CLIENT}, not-an-ip`,
        `${CLIENT}, garbage`,
        'not-an-ip',
        'unknown',
        `${CLIENT},`,
        `${CLIENT}, `,
        '1.2.3.4:8080',
        ',',
      ]) {
        expect(resolveClientIdentity(requestFrom({ forwardedFor: forged }), ONE_PROXY)).toBe(
          PROXY_PEER,
        );
      }
    });

    it('skips a non-address inside the window instead of returning it as an identity', () => {
      // A proxy appends after whatever token the caller left in the middle: the walk
      // still lands on the real client, and never on the token the caller chose.
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: `not-an-ip, ${CLIENT}` }), ONE_PROXY),
      ).toBe(CLIENT);
      expect(
        resolveClientIdentity(
          requestFrom({ forwardedFor: `6.6.6.6, unknown, ${CLIENT}, 10.9.9.9` }),
          TWO_HOPS,
        ),
      ).toBe(CLIENT);
    });

    it('reads a bracketed or zone-qualified entry a proxy appended', () => {
      // Both spellings are addresses once normalized, so they are read as the
      // client rather than dropped onto the shared peer bucket.
      expect(resolveClientIdentity(requestFrom({ forwardedFor: '[2001:db8::1]' }), ONE_PROXY)).toBe(
        '2001:db8::1',
      );
      expect(
        resolveClientIdentity(requestFrom({ forwardedFor: 'fe80::1%eth0' }), ONE_PROXY),
      ).toBe('fe80::1');
    });

    it('ignores forwarded headers from a socket peer outside the CIDR allowlist', () => {
      expect(
        resolveClientIdentity(requestFrom({ peer: '172.16.4.9', forwardedFor: CLIENT }), TWO_NETWORKS),
      ).toBe(CLIENT);
      // A client that reaches the socket directly and forges the header: it is not
      // a configured proxy, so its claim about who it is is not read.
      expect(
        resolveClientIdentity(requestFrom({ peer: '198.51.100.4', forwardedFor: CLIENT }), ONE_PROXY),
      ).toBe('198.51.100.4');
    });

    it('matches IPv6 proxy networks too', () => {
      const trust: ProxyTrust = { hops: 1, cidrs: ['fd00:1234::/32'] };
      expect(
        resolveClientIdentity(requestFrom({ peer: 'fd00:1234::5', forwardedFor: CLIENT }), trust),
      ).toBe(CLIENT);
      expect(
        resolveClientIdentity(requestFrom({ peer: '2001:DB8::5', forwardedFor: CLIENT }), trust),
      ).toBe('2001:db8::5');
    });

    it('canonicalizes the forwarded identity it selects', () => {
      // Every legal spelling of one IPv6 client is one budget.
      for (const spelling of ['2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8:0:0:0:0:0:1']) {
        expect(resolveClientIdentity(requestFrom({ forwardedFor: spelling }), ONE_PROXY)).toBe(
          '2001:db8::1',
        );
      }
    });

    it('keeps separate budgets for separate clients behind one proxy', () => {
      const first = resolveClientIdentity(requestFrom({ forwardedFor: '203.0.113.7' }), ONE_PROXY);
      const second = resolveClientIdentity(requestFrom({ forwardedFor: '203.0.113.8' }), ONE_PROXY);
      expect(first).not.toBe(second);
    });
  });
});
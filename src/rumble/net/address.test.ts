import { describe, expect, it } from 'vitest';
import { addressGroup, isIpAddress, isLoopback, isPrivateAddress, trustedProxies } from './address';

describe('address groups for the per-address limits', () => {
  it('counts an IPv4 address as itself, and an IPv4-mapped IPv6 address as its IPv4', () => {
    expect(addressGroup('203.0.113.7')).toBe('203.0.113.7');
    expect(addressGroup('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(addressGroup('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts every IPv6 address of one /64 as one, however it is written', () => {
    const g = addressGroup('2001:db8:1:2::1');
    expect(g).toBe('2001:db8:1:2::/64');
    for (const a of ['2001:db8:1:2:ffff:ffff:ffff:fffe', '2001:0DB8:0001:0002:0:0:0:abcd', '2001:db8:1:2:a:b:c:d', '2001:db8:1:2::1%eth0']) expect(addressGroup(a)).toBe(g);
    expect(addressGroup('2001:db8:1:3::1')).not.toBe(g);
    expect(addressGroup('::1')).toBe('0:0:0:0::/64');
  });

  it('leaves anything that does not parse as itself', () => {
    expect(addressGroup('?')).toBe('?');
    expect(addressGroup('1:2:3')).toBe('1:2:3');
    expect(addressGroup('1::2::3')).toBe('1::2::3');
  });

  it('knows the loopback addresses (never limited) and nothing else', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['203.0.113.7', '::2', '2001:db8::1', '::ffff:10.0.0.1', '?', '']) expect(isLoopback(a)).toBe(false);
  });
});

describe('which addresses and proxies (L4.5B)', () => {
  it('an IP address is one real IPv4 or IPv6 address, nothing looser', () => {
    for (const ok of ['1.2.3.4', '203.0.113.7', '::1', '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001', '::ffff:198.51.100.2']) expect(isIpAddress(ok)).toBe(true);
    for (const bad of ['1.2', '::::', '999.1.1.1', '01.2.3.4', '1.2.3.4.5', '1.2.3.4, 5.6.7.8', 'abc', '', 'fe80::1%eth0', '2001:db8::1::2', '::ffff:999.1.1.1']) expect(isIpAddress(bad)).toBe(false);
  });

  it('private networks: RFC 1918, CGNAT / tailnets, IPv6 unique-local and link-local; public ones are not', () => {
    for (const p of ['10.1.2.3', '172.17.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.1.1', 'fd00::1', 'fc12:3456::1', 'fe80::1', '::ffff:172.18.0.2']) expect(isPrivateAddress(p)).toBe(true);
    for (const p of ['8.8.8.8', '172.32.0.1', '203.0.113.7', '2001:db8::1', '127.0.0.1']) expect(isPrivateAddress(p)).toBe(false);
  });

  it('TRUSTED_PROXIES: keywords, exact addresses (any spelling), IPv4 ranges; unreadable entries trust nothing and are reported', () => {
    const t = trustedProxies('loopback, 192.0.2.10 10.0.0.0/8, 2001:db8::5, bogus, 300.1.1.1/8, 1.2.3.4/40');
    expect(t.invalid).toEqual(['bogus', '300.1.1.1/8', '1.2.3.4/40']);
    for (const yes of ['127.0.0.1', '::1', '192.0.2.10', '::ffff:192.0.2.10', '10.200.3.4', '2001:0db8:0000:0000:0000:0000:0000:0005']) expect(t.trusts(yes)).toBe(true);
    for (const no of ['192.0.2.11', '11.0.0.1', '2001:db8::6', '172.17.0.1', '8.8.8.8']) expect(t.trusts(no)).toBe(false);
    const priv = trustedProxies('private');
    expect(priv.trusts('172.17.0.1') && priv.trusts('127.0.0.1') && priv.trusts('::ffff:10.0.0.2')).toBe(true);
    expect(priv.trusts('203.0.113.9')).toBe(false);
    expect(trustedProxies('').trusts('127.0.0.1')).toBe(false);
  });
});


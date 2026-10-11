import { describe, expect, it } from 'vitest';
import { addressGroup, isLoopback } from './address';

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

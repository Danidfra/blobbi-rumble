/**
 * WHO IS "ONE ADDRESS" for the per-address limits (security audit H1, M2,
 * M3): an IPv4 address as it is; an IPv6 address by its /64 (one household
 * or one server is handed a whole /64, and rotating through it must not
 * multiply a limit); an IPv4-mapped IPv6 address (::ffff:1.2.3.4) as its
 * IPv4. Anything that does not parse stays itself.
 *
 * Loopback addresses are not limited: on the host they are the operator
 * (a smoke check, local development), and behind a tunnel without a client
 * address header every player would be the tunnel's loopback (one limit for
 * everyone would be an outage, not a protection; set CLIENT_IP_HEADER).
 */

/** The group an address is counted in. */
export function addressGroup(address: string): string {
  const a = address.trim().toLowerCase();
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return mapped[1];
  if (!a.includes(':')) return a;
  const words = expandIpv6(a);
  return words ? `${words.slice(0, 4).join(':')}::/64` : a;
}

/** Whether an address is this machine's own (127.0.0.0/8, ::1, or IPv4-mapped loopback). */
export function isLoopback(address: string): boolean {
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addressGroup(address))) return true;
  return expandIpv6(address.trim().toLowerCase())?.join(':') === '0:0:0:0:0:0:0:1';
}

/** The eight 16-bit words of an IPv6 address (no zone, no embedded IPv4 beyond the mapped form), or null. */
function expandIpv6(a: string): string[] | null {
  const s = a.replace(/%.*$/, '');
  if (!/^[0-9a-f:]+$/.test(s) || s.split('::').length > 2) return null;
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - h.length - t.length;
  if (fill < 0 || (tail === null && h.length !== 8)) return null;
  const words = [...h, ...Array(fill).fill('0'), ...t];
  if (words.length !== 8 || !words.every((w) => /^[0-9a-f]{1,4}$/.test(w))) return null;
  return words.map((w) => w.replace(/^0+(?=.)/, ''));
}

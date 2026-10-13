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

/** L4.5B: whether a text is one IP address, IPv4 or IPv6 (`node:net`'s rule, without the import: this module stays pure). */
export function isIpAddress(text: string): boolean {
  const a = text.trim().toLowerCase();
  if (/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(a)) return a.split('.').every((n) => Number(n) <= 255 && String(Number(n)) === n);
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) return isIpAddress(mapped[1]);
  return expandIpv6(a) !== null && !a.includes('%');
}

/** L4.5B: a private network's address (RFC 1918, CGNAT / tailnets 100.64/10, IPv6 unique-local fc00::/7 and link-local fe80::/10). */
export function isPrivateAddress(address: string): boolean {
  const g = addressGroup(address);
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(g);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  const w = expandIpv6(address.trim().toLowerCase());
  if (!w) return false;
  const first = parseInt(w[0], 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}

/**
 * L4.5B: which peers may tell the server a player's address (the proxy in
 * front, for CLIENT_IP_HEADER), from TRUSTED_PROXIES: a list of
 * `loopback`, `private` (any private network: a Docker bridge, a LAN
 * proxy), exact IPv4 / IPv6 addresses and IPv4 CIDR ranges, comma- or
 * space-separated. Returns the rule, and the entries it could not read
 * (the server warns about them; they trust nothing). An empty list trusts
 * no peer at all.
 */
export function trustedProxies(raw: string): { trusts: (peer: string) => boolean; invalid: string[] } {
  const rules: ((peer: string) => boolean)[] = [];
  const invalid: string[] = [];
  for (const entry of raw.split(/[\s,]+/).filter(Boolean).slice(0, 64)) {
    const e = entry.toLowerCase();
    if (e === 'loopback') rules.push(isLoopback);
    else if (e === 'private') rules.push((p) => isLoopback(p) || isPrivateAddress(p));
    else if (/^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(e)) {
      const [ip, bitsText] = e.split('/');
      const bits = Number(bitsText);
      if (!isIpAddress(ip) || bits > 32) {
        invalid.push(entry);
        continue;
      }
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const base = ipv4Number(ip)! & mask;
      rules.push((p) => {
        const n = ipv4Number(addressGroup(p));
        return n !== null && (n & mask) >>> 0 === base >>> 0;
      });
    } else if (isIpAddress(e)) {
      const want = canonicalIp(e);
      rules.push((p) => canonicalIp(p) === want);
    } else invalid.push(entry);
  }
  return { trusts: (peer) => rules.some((r) => r(peer)), invalid };
}

const ipv4Number = (ip: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0 : null;
};
/** One spelling per address: IPv4 (mapped or not) as dotted, IPv6 as its eight expanded words. */
const canonicalIp = (ip: string): string => {
  const g = addressGroup(ip);
  if (!g.includes(':')) return g;
  return expandIpv6(ip.trim().toLowerCase())?.join(':') ?? ip;
};

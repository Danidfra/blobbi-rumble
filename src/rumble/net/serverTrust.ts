/**
 * WHERE THE MATCH RUNS, in a word a player understands. Pure; the page
 * uses it for the session chip, a future invite for its card.
 *
 *   Local server      this machine, the LAN, a tailnet (localhost, private
 *                     and link-local addresses, *.local)
 *   Official server   a Blobbi host on the built-in list, over TLS: the only
 *                     check is the TLS certificate for that name
 *   Community server  anywhere else whose server names an operator pubkey:
 *                     as the server claims; nothing proves the key's owner
 *                     agreed (labelled so)
 *   Unknown server    anywhere else
 *
 * Every one of them is the authority over its matches: the label says who
 * that is, so nobody mistakes a friend's laptop for a neutral referee.
 */
export const OFFICIAL_HOSTS: readonly string[] = Object.freeze(['rumble.blobbi.pet']);

export type TrustKind = 'local' | 'official' | 'community' | 'unknown';

export interface ServerTrust {
  kind: TrustKind;
  label: string;
  host: string;
  /** One sentence for whoever wants to know more. */
  detail: string;
}

/** Whether a host name or address is this machine or a private network. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function classifyServer(wsUrl: string, info: { operator?: string | null } | null, official: readonly string[] = OFFICIAL_HOSTS): ServerTrust {
  let u: URL;
  try {
    u = new URL(wsUrl);
  } catch {
    return { kind: 'unknown', label: 'Unknown server', host: '?', detail: 'The server address could not be read.' };
  }
  const host = u.host;
  if (isLocalHost(u.hostname)) return { kind: 'local', label: 'Local server', host, detail: `This match runs on ${host}, on this machine or your local network.` };
  if (u.protocol === 'wss:' && official.includes(u.hostname.toLowerCase())) return { kind: 'official', label: 'Official server', host, detail: `This match runs on ${host}, an official Blobbi server.` };
  if (info?.operator) return { kind: 'community', label: 'Community server', host, detail: `This match runs on ${host}, a server run by someone else (its operator, as the server states).` };
  return { kind: 'unknown', label: 'Unknown server', host, detail: `This match runs on ${host}. Whoever runs it decides the match.` };
}

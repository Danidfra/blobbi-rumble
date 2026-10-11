/**
 * ROOM IDS: short codes a person can read out, type and share, generated
 * by the server. Pure; shared by the server (generation, lookup) and the
 * page (links, the Join box).
 *
 * Four characters from 31 that cannot be confused with each other (no 0/O,
 * 1/I/L): about 920 000 codes per server, plenty to keep a handful of live
 * rooms apart and to make stumbling into one by typing unlikely. A code
 * names a room; it is not a secret and grants nothing beyond what any
 * visitor of the server can do (a future invite ticket will carry access).
 *
 * The open room (Quick Match, L4.1) is `OPEN`: it contains an O, so no
 * generated code can ever be it. L4.1: the public social plaza is `PLAZA`
 * (an L: never generated either).
 */
export const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_ID_LENGTH = 4;
export const OPEN_ROOM = 'OPEN';
export const PLAZA_ROOM = 'PLAZA';
const GENERATED = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_ID_LENGTH}}$`);

/** A room id from anything a person typed or a URL carried: upper-cased, spaces and dashes dropped; null if it is not one. */
export function normalizeRoomId(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 16) return null;
  const s = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return s === OPEN_ROOM || s === PLAZA_ROOM || GENERATED.test(s) ? s : null;
}

/** A fresh code no live room has. `random` gives integers in [0, n) (crypto in production). */
export function newRoomId(taken: (id: string) => boolean, random: (n: number) => number = cryptoInt): string {
  for (let attempt = 0; attempt < 64; attempt++) {
    let id = '';
    for (let i = 0; i < ROOM_ID_LENGTH; i++) id += ROOM_ALPHABET[random(ROOM_ALPHABET.length)];
    if (!taken(id)) return id;
  }
  throw new Error('no free room id');
}

function cryptoInt(n: number): number {
  // Rejection sampling: no modulo bias.
  const limit = Math.floor(256 / n) * n;
  const b = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(b);
    if (b[0] < limit) return b[0] % n;
  }
}

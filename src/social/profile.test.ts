/**
 * Profiles are hostile input: parse what is usable, clean and bound text,
 * keep only https pictures, and fall back to a short npub and a
 * deterministic identicon when there is nothing.
 */
import { generateSecretKey, getPublicKey, type NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { fallbackAvatar } from './avatar';
import { shortNpub } from './keys';
import { PROFILE_LIMITS, cleanText, clip, displayName, parseProfile, safeImageUrl } from './profile';

const pk = getPublicKey(generateSecretKey());
const now = Math.floor(Date.now() / 1000);
const kind0 = (content: unknown, over: Partial<NostrEvent> = {}): NostrEvent => ({ kind: 0, pubkey: pk, created_at: now - 10, tags: [], content: typeof content === 'string' ? content : JSON.stringify(content), id: '0'.repeat(64), sig: '0'.repeat(128), ...over });

describe('reading a kind-0 profile', () => {
  it('reads the standard fields', () => {
    const p = parseProfile(kind0({ name: 'daniel', display_name: 'Daniel', picture: 'https://img.example/a.png', nip05: 'Daniel@Example.com', about: 'hi' }))!;
    expect(p).toEqual({ pubkey: pk, createdAt: now - 10, name: 'daniel', displayName: 'Daniel', picture: 'https://img.example/a.png', nip05: 'daniel@example.com' });
    expect(displayName(p, pk)).toBe('Daniel');
    expect(displayName({ ...p, displayName: undefined }, pk)).toBe('daniel');
    // The deprecated camelCase field still reads.
    expect(parseProfile(kind0({ displayName: 'Old' }))!.displayName).toBe('Old');
  });

  it('a missing or unusable profile falls back to a short npub', () => {
    expect(displayName(null, pk)).toBe(shortNpub(pk));
    expect(displayName(undefined, pk)).toMatch(/^npub1[a-z0-9]{4}…[a-z0-9]{4}$/);
    expect(parseProfile(kind0('{not json'))).toBeNull();
    expect(parseProfile(kind0('[1,2]'))).toBeNull();
    expect(parseProfile(kind0('"a string"'))).toBeNull();
    expect(parseProfile(kind0('null'))).toBeNull();
    expect(parseProfile(kind0({}, { kind: 1 }))).toBeNull();
    // Dated far in the future: ignored (it would otherwise win "newest" forever).
    expect(parseProfile(kind0({ name: 'x' }, { created_at: now + 3600 }), now)).toBeNull();
    // Fields of the wrong type are just absent.
    expect(parseProfile(kind0({ name: 42, display_name: { a: 1 }, picture: ['https://x'] }))).toEqual({ pubkey: pk, createdAt: now - 10 });
  });

  it('refuses huge metadata unread, and bounds long fields', () => {
    expect(parseProfile(kind0({ name: 'x'.repeat(PROFILE_LIMITS.maxContent) }))).toBeNull();
    const p = parseProfile(kind0({ name: 'n'.repeat(5000), display_name: '😀'.repeat(300) }))!;
    expect(Array.from(p.name!).length).toBe(PROFILE_LIMITS.maxName);
    expect(Array.from(p.displayName!).length).toBe(PROFILE_LIMITS.maxName);
    expect(p.name!.endsWith('…')).toBe(true);
  });

  it('keeps markup as plain text and strips control, direction-override and invisible characters', () => {
    const p = parseProfile(kind0({ name: '<script>alert(1)</script>', display_name: 'Ev‮il​\u0000Name\n\tX' }))!;
    // Kept as literal characters: it is only ever shown with textContent / canvas text.
    expect(p.name).toBe('<script>alert(1)</script>');
    expect(p.displayName).toBe('Ev il Name X');
    expect(cleanText('⁦⁧⁨⁩﻿', 10)).toBeUndefined();
    // Combining-mark piles (zalgo) cut to two per character.
    expect(cleanText('Ź̂̃̄̅a', 10)).toBe('Ź̂a');
    expect(cleanText('   ', 10)).toBeUndefined();
  });

  it('keeps a picture only as a plain https URL', () => {
    expect(safeImageUrl('https://img.example/a.png')).toBe('https://img.example/a.png');
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://img.example/a.png', 'https://user:pw@img.example/a.png', 'file:///etc/passwd', '//img.example/a.png', 'not a url', `https://x.example/${'a'.repeat(2000)}`, 42, null])
      expect(safeImageUrl(bad)).toBeUndefined();
    expect(parseProfile(kind0({ picture: 'javascript:alert(1)' }))!.picture).toBeUndefined();
  });

  it('clips labels by characters, not bytes', () => {
    expect(clip('Daniel', 14)).toBe('Daniel');
    expect(clip('A very long display name', 10)).toBe('A very lo…');
    expect(Array.from(clip('😀'.repeat(20), 5)).length).toBe(5);
  });
});

describe('the fallback avatar', () => {
  it('is the same for the same pubkey, different for another, mirrored, never blank', () => {
    const a = fallbackAvatar(pk);
    expect(fallbackAvatar(pk)).toEqual(a);
    expect(a.cells).toHaveLength(25);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
    for (let r = 0; r < 5; r++) {
      expect(a.cells[r * 5]).toBe(a.cells[r * 5 + 4]);
      expect(a.cells[r * 5 + 1]).toBe(a.cells[r * 5 + 3]);
    }
    const others = Array.from({ length: 8 }, () => fallbackAvatar(getPublicKey(generateSecretKey())));
    expect(others.some((o) => JSON.stringify(o) !== JSON.stringify(a))).toBe(true);
    expect(fallbackAvatar('0'.repeat(64)).cells.some(Boolean)).toBe(true);
  });
});

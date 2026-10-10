/**
 * Looks (M9C), without sockets: a declaration is read strictly and bound to
 * the proven owner (the address prefix is theirs; the seed is derived here,
 * never taken from the client); the host carries a look only for a
 * connection with a proven identity in a slot, drops it with the identity
 * or the connection, and reports a change only when there is one.
 * Throwaway TEST keys.
 */
import { deriveBlobbiV3Seed, getCanonicalBlobbiD } from '@blobbi-kit/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import { RumbleHost } from './host';
import { LOOKS, bindLook, parseLookDeclaration, sameForm } from './looks';

const A = getPublicKey(generateSecretKey());
const B = getPublicKey(generateSecretKey());
const dA = getCanonicalBlobbiD(A, '0123456789');
const dB = getCanonicalBlobbiD(B, '0123456789');

describe('a look declaration', () => {
  it('is exactly { v, d, gen, colors?, name? }, bounded and cleaned; colours only on V1 / V2', () => {
    expect(parseLookDeclaration({ v: 1, d: dA, gen: 'v3' })).toEqual({ v: 1, d: dA, gen: 'v3' });
    expect(parseLookDeclaration({ v: 1, d: dA, gen: 'v1', colors: { base: '#AABBCC', secondary: '#000000', eye: '#ffffff' }, name: ' Puck‮ <b>x</b> ' })).toEqual({ v: 1, d: dA, gen: 'v1', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' }, name: 'Puck <b>x</b>' });
    expect(parseLookDeclaration({ v: 1, d: dA, gen: 'v3', name: '' })).toEqual({ v: 1, d: dA, gen: 'v3' });
    expect(parseLookDeclaration({ v: 1, d: dA, gen: 'v3', name: 'x'.repeat(100) })!.name).toHaveLength(LOOKS.maxName);
    for (const bad of [null, 'x', [], { v: 1 }, { v: 0, d: dA, gen: 'v3' }, { v: 1, d: 'blobbi-puck', gen: 'v3' }, { v: 1, d: dA, gen: 'v4' }, { v: 1, d: dA, gen: 'v3', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' } }, { v: 1, d: dA, gen: 'v2', colors: { base: '#aabbcc' } }, { v: 1, d: dA, gen: 'v2', colors: 'red' }, { v: 1, d: dA, gen: 'v3', seed: 'a'.repeat(64) }, { v: 1, d: dA, gen: 'v3', pubkey: B }, { v: 1, d: dA, gen: 'v3', name: 42 }])
      expect(parseLookDeclaration(bad), JSON.stringify(bad)).toBeNull();
  });

  it('binds only to the owner: the address prefix must be the proven pubkey’s, and the seed is derived from (pubkey, d)', () => {
    const bound = bindLook(A, { v: 1, d: dA, gen: 'v3' })!;
    expect(bound.seed).toBe(deriveBlobbiV3Seed(A, dA));
    expect(bindLook(A, { v: 1, d: dB, gen: 'v3' })).toBeNull();
    expect(bindLook(B, { v: 1, d: dA, gen: 'v3' })).toBeNull();
    expect(bindLook('nope', { v: 1, d: dA, gen: 'v3' })).toBeNull();
    // The same address is the same seed for everyone; two owners' Blobbis never share one.
    expect(bindLook(A, { v: 1, d: dA, gen: 'v1' })!.seed).toBe(bound.seed);
    expect(bindLook(B, { v: 1, d: dB, gen: 'v3' })!.seed).not.toBe(bound.seed);
    expect(sameForm(bound, bindLook(A, { v: 1, d: dA, gen: 'v3' }))).toBe(true);
    expect(sameForm(bound, bindLook(A, { v: 1, d: dA, gen: 'v3', name: 'Puck' }))).toBe(false);
    expect(sameForm(null, undefined)).toBe(true);
  });
});

describe('looks in the host', () => {
  let havok: HavokInstance;
  beforeAll(async () => {
    havok = await loadHavokNode();
  });

  it('only a proven identity in a slot may wear a form of its own; the roster carries it; a change is reported once', () => {
    const host = new RumbleHost({ havok });
    host.connect(1);
    host.connect(2);
    expect(host.setLook(1, { v: 1, d: dA, gen: 'v3' })).toEqual({ ok: false, reason: 'no-identity' });
    host.setIdentity(1, A);
    expect(host.setLook(1, { v: 1, d: dB, gen: 'v3' })).toEqual({ ok: false, reason: 'not-yours' });
    expect(host.setLook(1, { v: 1, d: dA, gen: 'v3', name: 'Puck' })).toEqual({ ok: true, changed: true });
    expect(host.setLook(1, { v: 1, d: dA, gen: 'v3', name: 'Puck' })).toEqual({ ok: true, changed: false });
    expect(host.roster().slots.P1).toEqual({ who: 'nostr', pubkey: A, form: { v: 1, d: dA, gen: 'v3', name: 'Puck', seed: deriveBlobbiV3Seed(A, dA) } });
    expect(host.roster().slots.P2).toEqual({ who: 'guest' });
    // Another slot's connection cannot touch P1's look: it only ever sets its own.
    host.setIdentity(2, B);
    expect(host.setLook(2, { v: 1, d: dA, gen: 'v3' })).toEqual({ ok: false, reason: 'not-yours' });
    expect(host.setLook(2, { v: 1, d: dB, gen: 'v2', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' } })).toEqual({ ok: true, changed: true });
    expect(host.roster().slots.P2).toMatchObject({ who: 'nostr', pubkey: B, form: { d: dB, gen: 'v2', colors: { base: '#aabbcc' } } });
    expect(host.roster().slots.P1).toMatchObject({ form: { d: dA } });
    // The default again.
    expect(host.setLook(1, null)).toEqual({ ok: true, changed: true });
    expect(host.setLook(1, null)).toEqual({ ok: true, changed: false });
    expect(host.roster().slots.P1).toEqual({ who: 'nostr', pubkey: A });
    expect(host.lookOf(1)).toBeNull();
    host.dispose();
  });

  it('a look goes with its identity (logout, another pubkey) and with its connection; a spectator wears nothing; unknown connections are refused', () => {
    const host = new RumbleHost({ havok });
    host.connect(1);
    host.setIdentity(1, A);
    host.setLook(1, { v: 1, d: dA, gen: 'v3' });
    host.setIdentity(1, null);
    expect(host.lookOf(1)).toBeNull();
    expect(host.roster().slots.P1).toEqual({ who: 'guest' });
    host.setIdentity(1, A);
    host.setLook(1, { v: 1, d: dA, gen: 'v3' });
    host.setIdentity(1, B);
    expect(host.lookOf(1)).toBeNull();
    host.setIdentity(1, A);
    host.setLook(1, { v: 1, d: dA, gen: 'v3' });
    host.disconnect(1);
    expect(host.lookOf(1)).toBeNull();
    expect(host.roster().slots.P1).toEqual({ who: 'bot' });
    // The next holder of P1 starts with the default, whoever they are.
    host.connect(2);
    host.setIdentity(2, A);
    expect(host.roster().slots.P1).toEqual({ who: 'nostr', pubkey: A });
    for (const c of [3, 4, 5, 6]) host.connect(c);
    expect(host.slot(6)).toBeNull();
    host.setIdentity(6, B);
    expect(host.setLook(6, { v: 1, d: dB, gen: 'v3' })).toEqual({ ok: false, reason: 'spectator' });
    expect(host.setLook(99, { v: 1, d: dB, gen: 'v3' })).toEqual({ ok: false, reason: 'spectator' });
    host.dispose();
  });

  it('a look never reaches the match: the state message is unchanged by it, and no gameplay number moves', () => {
    const host = new RumbleHost({ havok });
    host.connect(1);
    host.setIdentity(1, A);
    const before = JSON.stringify(host.state());
    host.setLook(1, { v: 1, d: dA, gen: 'v2', colors: { base: '#aabbcc', secondary: '#000000', eye: '#ffffff' }, name: 'Puck' });
    expect(JSON.stringify(host.state())).toBe(before);
    expect(before).not.toMatch(/seed|form|blobbi-/);
    host.dispose();
  });
});

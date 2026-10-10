/**
 * Which room a page wants and its links (M8B): share-link paths, query
 * forms, malformed codes, the socket URL for a room, the page address after
 * a switch, and the link to share.
 */
import { describe, expect, it } from 'vitest';
import { describe as words, initialConnection, onClose } from './connection';
import { pageAddress, roomIntent, shareLink, socketUrl, isOwnServer } from './room';

describe('room intents from the page address', () => {
  it('reads /play/<code>, ?room=, ?create=1, and the open room', () => {
    expect(roomIntent({ pathname: '/play/A7F2', search: '' })).toEqual({ kind: 'join', id: 'A7F2' });
    expect(roomIntent({ pathname: '/play/a7f2', search: '?server=ws://x' })).toEqual({ kind: 'join', id: 'A7F2' });
    expect(roomIntent({ pathname: '/rumble.html', search: '?network=1&room=a7-f2' })).toEqual({ kind: 'join', id: 'A7F2' });
    expect(roomIntent({ pathname: '/rumble.html', search: '?network=1&create=1' })).toEqual({ kind: 'create', listed: false });
    expect(roomIntent({ pathname: '/rumble.html', search: '?network=1' })).toEqual({ kind: 'open' });
    expect(roomIntent({ pathname: '/play/OPEN', search: '' })).toEqual({ kind: 'open' });
  });

  it('a malformed code is invalid (shown, never sent)', () => {
    expect(roomIntent({ pathname: '/play/A0F2', search: '' })).toEqual({ kind: 'invalid', raw: 'A0F2' });
    expect(roomIntent({ pathname: '/play/%E0%A4%A', search: '' }).kind).toBe('invalid');
    expect(roomIntent({ pathname: '/play/', search: '' }).kind).toBe('invalid');
    expect(roomIntent({ pathname: '/rumble.html', search: `?room=${'x'.repeat(40)}` })).toEqual({ kind: 'invalid', raw: 'x'.repeat(16) });
  });
});

describe('links', () => {
  it('the socket URL carries the room (and nothing else changes)', () => {
    expect(socketUrl('wss://rumble.example/ws', { kind: 'join', id: 'A7F2' })).toBe('wss://rumble.example/ws?room=A7F2');
    expect(socketUrl('ws://127.0.0.1:8787', { kind: 'create' })).toBe('ws://127.0.0.1:8787/?create=1');
    expect(socketUrl('wss://rumble.example/ws?room=ZZZZ', { kind: 'open' })).toBe('wss://rumble.example/ws');
  });

  it('the page address after a switch keeps the flags that matter', () => {
    expect(pageAddress('A7F2', '?network=1&create=1&server=ws%3A%2F%2Fx&relays=ws%3A%2F%2Fr')).toBe('/play/A7F2?server=ws%3A%2F%2Fx&relays=ws%3A%2F%2Fr');
    expect(pageAddress('A7F2', '')).toBe('/play/A7F2');
    expect(pageAddress(null, '?room=A7F2&interp=0')).toBe('/rumble.html?interp=0&network=1');
  });

  it('the share link: the server’s canonical one if it gave one (http(s) only), else this page’s origin', () => {
    expect(shareLink('A7F2', 'http://192.168.1.4:8080', 'https://rumble.example/play/A7F2')).toBe('https://rumble.example/play/A7F2');
    expect(shareLink('A7F2', 'http://192.168.1.4:8080')).toBe('http://192.168.1.4:8080/play/A7F2');
    expect(shareLink('A7F2', 'http://192.168.1.4:8080', 'javascript:alert(1)')).toBe('http://192.168.1.4:8080/play/A7F2');
    expect(shareLink('A7F2', 'http://h', 'https://u:p@evil.example/x')).toBe('http://h/play/A7F2');
  });
});

describe('connection words for rooms', () => {
  it('a missing room and a refused creation do not retry, and offer the way out', () => {
    const c = initialConnection('ws://x', 'ZZZZ');
    const missing = onClose(c, 4004, 'no such room', 1);
    expect(missing.phase).toBe('missing');
    expect(missing.retryAt).toBe(Infinity);
    expect(words(missing, 2)).toMatchObject({ title: 'Room ZZZZ isn’t here', actions: ['open', 'host'] });
    const refused = onClose(c, 4003, 'too many new rooms, wait a minute', 1);
    expect(words(refused, 2)).toMatchObject({ title: 'Couldn’t start a new game', detail: expect.stringMatching(/wait a minute/), actions: ['open', 'retry'] });
    const full = onClose(c, 1013, 'room full', 1);
    expect(full.phase).toBe('full');
    expect(words(full, 2)!.title).toBe('Room ZZZZ is full');
    expect(words(onClose(initialConnection('ws://x'), 1013, 'server full', 1), 2)!.title).toBe('The server is full');
  });
});

describe('public rooms and server-aware links (M10)', () => {
  it('?create=1&public=1 asks for a listed room; the socket URL carries it; a plain create stays unlisted', () => {
    expect(roomIntent({ pathname: '/rumble.html', search: '?network=1&create=1&public=1' })).toEqual({ kind: 'create', listed: true });
    expect(roomIntent({ pathname: '/rumble.html', search: '?create=1' })).toEqual({ kind: 'create', listed: false });
    expect(socketUrl('wss://s.example/ws', { kind: 'create', listed: true })).toBe('wss://s.example/ws?create=1&public=1');
    expect(socketUrl('wss://s.example/ws?public=1', { kind: 'create' })).toBe('wss://s.example/ws?create=1');
    expect(socketUrl('wss://s.example/ws?public=1', { kind: 'join', id: 'A7F2' })).toBe('wss://s.example/ws?room=A7F2');
  });
  it('a share link names the server when the page is not served by it (and has no public address); the server’s own address needs nothing', () => {
    expect(shareLink('A7F2', 'https://site.example', undefined, 'wss://site.example/ws')).toBe('https://site.example/play/A7F2');
    expect(shareLink('A7F2', 'http://192.168.1.5:5177', undefined, 'ws://192.168.1.5:8787/')).toBe('http://192.168.1.5:5177/play/A7F2?server=ws%3A%2F%2F192.168.1.5%3A8787%2F');
    expect(shareLink('A7F2', 'https://site.example', undefined, 'wss://friend.example/ws')).toBe('https://site.example/play/A7F2?server=wss%3A%2F%2Ffriend.example%2Fws');
    // The server's canonical link wins: that server serves the page too.
    expect(shareLink('A7F2', 'https://site.example', 'https://friend.example/play/A7F2', 'wss://friend.example/ws')).toBe('https://friend.example/play/A7F2');
    expect(isOwnServer('https://site.example', 'wss://site.example/ws')).toBe(true);
    expect(isOwnServer('https://site.example', 'ws://site.example/ws')).toBe(false);
    expect(isOwnServer('https://site.example', 'not a url')).toBe(false);
    // The page keeps ?server= across a room switch, so the link's server stays the page's.
    expect(pageAddress('A7F2', '?server=wss%3A%2F%2Ffriend.example%2Fws&create=1')).toBe('/play/A7F2?server=wss%3A%2F%2Ffriend.example%2Fws');
  });
});

/**
 * Copying a link: one click where the browser allows it (a secure context
 * with the Clipboard API), otherwise (or when it refuses) "manual": the
 * page selects the link and names the shortcut. Never throws.
 */
import { describe, expect, it } from 'vitest';
import { canCopy, copyShortcut, copyText } from './clipboard';

const secure = (writeText: (t: string) => Promise<void>) => ({ isSecureContext: true, navigator: { clipboard: { writeText } } });

describe('copying a link', () => {
  it('copies in a secure context (https, localhost)', async () => {
    const got: string[] = [];
    const env = secure(async (t) => void got.push(t));
    expect(canCopy(env)).toBe(true);
    expect(await copyText('https://rumble.example/play/A7F2', env)).toBe('copied');
    expect(got).toEqual(['https://rumble.example/play/A7F2']);
  });

  it('plain http on a LAN: no Clipboard API at all, so manual, without an error', async () => {
    const lan = { isSecureContext: false, navigator: {} };
    expect(canCopy(lan)).toBe(false);
    expect(await copyText('http://192.168.1.4:8080/play/A7F2', lan)).toBe('manual');
    expect(await copyText('x', {})).toBe('manual');
    // An API without a secure context is not trusted either.
    expect(canCopy({ isSecureContext: false, navigator: { clipboard: { writeText: async () => {} } } })).toBe(false);
  });

  it('a refusal (no permission, page not focused) falls back to manual', async () => {
    expect(await copyText('x', secure(() => Promise.reject(new DOMException('denied', 'NotAllowedError'))))).toBe('manual');
    expect(await copyText('x', secure(() => { throw new Error('sync'); }))).toBe('manual');
  });

  it('names the right shortcut', () => {
    expect(copyShortcut({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } })).toBe('⌘C');
    expect(copyShortcut({ navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } })).toBe('Ctrl+C');
    expect(copyShortcut({})).toBe('Ctrl+C');
  });
});

/**
 * M12.1 full screen: the standard API or Safari's prefixed one, only on the
 * player's click; a plain word where there is none (iPhone Safari) and when
 * the game already runs from the home screen.
 */
import { describe, expect, it } from 'vitest';
import { fullscreenNote, fullscreenState, isStandalone, toggleFullscreen } from './fullscreen';

describe('full screen', () => {
  it('reads the standard and the prefixed API, and the home-screen app', () => {
    expect(fullscreenState({ fullscreenEnabled: true }, false)).toEqual({ supported: true, active: false, standalone: false });
    expect(fullscreenState({ webkitFullscreenEnabled: true, webkitFullscreenElement: {} as Element }, false)).toMatchObject({ supported: true, active: true });
    expect(fullscreenState({}, false).supported).toBe(false);
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
    expect(isStandalone({ matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) })).toBe(true);
    expect(isStandalone({ matchMedia: () => ({ matches: false }) })).toBe(false);
  });

  it('enters with whichever API exists and leaves the same way; a refusal is reported, not thrown', async () => {
    const calls: string[] = [];
    expect(await toggleFullscreen({}, { requestFullscreen: async () => void calls.push('std') })).toBe(true);
    expect(await toggleFullscreen({}, { webkitRequestFullscreen: () => void calls.push('webkit') })).toBe(true);
    expect(await toggleFullscreen({ fullscreenElement: {} as Element, exitFullscreen: async () => void calls.push('exit') }, {})).toBe(true);
    expect(await toggleFullscreen({}, { requestFullscreen: () => Promise.reject(new Error('no')) })).toBe(false);
    expect(await toggleFullscreen({}, {})).toBe(false);
    expect(calls).toEqual(['std', 'webkit', 'exit']);
  });

  it('says how to get the bars away where the browser has no full screen, and nothing where the button does it', () => {
    expect(fullscreenNote({ supported: false, active: false, standalone: false })).toMatch(/Add to Home Screen/);
    expect(fullscreenNote({ supported: true, active: false, standalone: false })).toBeNull();
    expect(fullscreenNote({ supported: false, active: false, standalone: true })).toMatch(/home screen/);
  });
});

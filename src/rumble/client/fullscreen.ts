/**
 * FULL SCREEN (M12.1): the standard Fullscreen API, or Safari's prefixed
 * one (iPad), only ever on the player's click; and, where neither exists
 * (iPhone Safari has no full screen for page elements), a plain word on
 * the way that does work there: the home-screen app (`manifest.json`),
 * which opens without the browser's bars. Nothing fakes a full screen.
 */

interface PrefixedDocument {
  fullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
}
interface PrefixedElement {
  requestFullscreen?: (o?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => void;
}

export interface FullscreenState {
  /** The browser can put the page in full screen. */
  supported: boolean;
  /** It is in full screen now. */
  active: boolean;
  /** Started from the home screen (a standalone app): already without the browser's bars. */
  standalone: boolean;
}

export function fullscreenState(doc: PrefixedDocument, standalone: boolean): FullscreenState {
  const supported = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
  const active = !!(doc.fullscreenElement || doc.webkitFullscreenElement);
  return { supported, active, standalone };
}

/** Enter or leave full screen; resolves to whether the browser did what was asked. */
export async function toggleFullscreen(doc: PrefixedDocument, el: PrefixedElement): Promise<boolean> {
  try {
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      if (doc.exitFullscreen) await doc.exitFullscreen();
      else doc.webkitExitFullscreen?.();
      return true;
    }
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    return false;
  }
}

/** What the settings say about full screen, or null when the button says it all. */
export function fullscreenNote(s: FullscreenState): string | null {
  if (s.standalone) return 'Started from the home screen: the browser’s bars are already gone.';
  if (s.supported) return null;
  return 'This browser has no full screen for web pages. On iPhone: Share → Add to Home Screen, then start Blobbi Rumble from its icon: it opens without Safari’s bars.';
}

/** Whether this page runs as a home-screen app (the manifest's standalone display, or iOS's own flag). */
export function isStandalone(win: { matchMedia?: (q: string) => { matches: boolean }; navigator?: { standalone?: boolean } }): boolean {
  return !!(win.matchMedia?.('(display-mode: standalone)').matches || win.matchMedia?.('(display-mode: fullscreen)').matches || win.navigator?.standalone);
}

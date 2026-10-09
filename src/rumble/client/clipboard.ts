/**
 * COPYING A LINK, honestly. Browsers expose the Clipboard API only in a
 * secure context: https pages and localhost. A page opened on a LAN address
 * over plain http (http://192.168.1.4:8080) gets no `navigator.clipboard`
 * at all, by design, and there is no safe way around that (the old
 * `execCommand('copy')` is deprecated and not used here).
 *
 * So: where one-click copy is possible, copy; where it is not (or the
 * browser refuses, e.g. no permission), the caller selects the visible
 * link and tells the player which keys copy it. Pure apart from the
 * environment passed in.
 */
export interface ClipboardEnv {
  isSecureContext?: boolean;
  navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> }; userAgent?: string };
}

const defaultEnv = (): ClipboardEnv => (typeof window === 'undefined' ? {} : window);

/** Whether a one-click copy can work here at all. */
export function canCopy(env: ClipboardEnv = defaultEnv()): boolean {
  return env.isSecureContext === true && typeof env.navigator?.clipboard?.writeText === 'function';
}

/** Copy `text`: 'copied', or 'manual' when the player has to copy it themselves (never throws). */
export async function copyText(text: string, env: ClipboardEnv = defaultEnv()): Promise<'copied' | 'manual'> {
  if (!canCopy(env)) return 'manual';
  try {
    await env.navigator!.clipboard!.writeText!(text);
    return 'copied';
  } catch {
    return 'manual';
  }
}

/** The copy shortcut to name: ⌘C on Apple systems, Ctrl+C elsewhere. */
export function copyShortcut(env: ClipboardEnv = defaultEnv()): string {
  return /Mac|iPhone|iPad|iPod/.test(env.navigator?.userAgent ?? '') ? '⌘C' : 'Ctrl+C';
}

/**
 * THE NETWORK OVERLAY: what a remote tester needs to see without asking.
 * A small status pill (online as P2, watching, connecting, offline), a
 * centred banner when the game cannot be played (cannot connect, lost,
 * full) with a Retry button, a short note after a reconnect, and a compact
 * controls card (H hides it), struggle included. Plain DOM; the words come
 * from `connection.ts`.
 */
import { describe, statusLine, type ConnectionState } from './connection';

const CONTROLS_HTML = `
  <b>Controls</b>
  <div><kbd>WASD</kbd> / <kbd>←↑↓→</kbd> move · <kbd>Shift</kbd> run · <kbd>Space</kbd> / <kbd>Enter</kbd> jump</div>
  <div><kbd>F</kbd> / <kbd>K</kbd> punch · <kbd>G</kbd> / <kbd>L</kbd> grab, then again to throw</div>
  <div><b>Grabbed?</b> alternate <kbd>←</kbd><kbd>→</kbd> (or <kbd>A</kbd><kbd>D</kbd>) fast to break free</div>
  <div class="dim">Knock the others off the island · last Blobbi standing wins the round · <kbd>H</kbd> hides this</div>`;

export function createOverlay(onRetry: () => void) {
  const style = document.createElement('style');
  style.textContent = `
    .rn-pill { position: fixed; left: 12px; top: 12px; padding: 6px 12px; border-radius: 999px; background: rgba(255,255,255,0.88); font: 600 13px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; box-shadow: 0 4px 16px rgba(40,50,80,0.15); }
    .rn-pill.off { color: #b0413e; }
    .rn-banner { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(210,225,245,0.55); backdrop-filter: blur(2px); }
    .rn-banner > div { max-width: 460px; margin: 16px; padding: 18px 22px; border-radius: 16px; background: rgba(255,255,255,0.95); box-shadow: 0 10px 40px rgba(40,50,80,0.25); font: 14px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; text-align: center; }
    .rn-banner h2 { margin: 0 0 6px; font-size: 18px; }
    .rn-banner p { margin: 0 0 12px; color: #555a6e; word-break: break-word; }
    .rn-banner button { font: 600 14px ui-sans-serif, system-ui, sans-serif; padding: 8px 18px; border: 0; border-radius: 10px; background: #6fc38f; color: white; cursor: pointer; }
    .rn-note { position: fixed; left: 50%; top: 12px; transform: translateX(-50%); padding: 6px 14px; border-radius: 10px; background: rgba(43,43,58,0.85); color: white; font: 13px ui-sans-serif, system-ui, sans-serif; display: none; }
    .rn-controls { position: fixed; left: 12px; bottom: 12px; max-width: 360px; padding: 10px 14px; border-radius: 14px; background: rgba(255,255,255,0.86); font: 12px ui-sans-serif, system-ui, sans-serif; color: #2b2b3a; line-height: 1.6; box-shadow: 0 6px 22px rgba(40,50,80,0.15); }
    .rn-controls kbd { display: inline-block; padding: 0 5px; border-radius: 4px; background: #eef1f6; border: 1px solid #d6dbe6; font: 11px ui-monospace, Menlo, monospace; }
    .rn-controls .dim { color: #6b7082; }
  `;
  document.head.appendChild(style);
  const pill = document.createElement('div');
  pill.className = 'rn-pill';
  const banner = document.createElement('div');
  banner.className = 'rn-banner';
  banner.innerHTML = '<div><h2></h2><p></p><button type="button">Retry now</button></div>';
  const title = banner.querySelector('h2')!;
  const detail = banner.querySelector('p')!;
  const retry = banner.querySelector('button')!;
  retry.addEventListener('click', () => onRetry());
  const note = document.createElement('div');
  note.className = 'rn-note';
  const controls = document.createElement('div');
  controls.className = 'rn-controls';
  controls.innerHTML = CONTROLS_HTML;
  document.body.append(pill, banner, note, controls);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyH') controls.style.display = controls.style.display === 'none' ? '' : 'none';
  });

  let last = '';
  return {
    /** Bring the overlay up to date (cheap: it only touches the DOM when something changed). */
    show(s: ConnectionState, now: number, rttMs: number) {
      const d = describe(s, now);
      const line = statusLine(s, rttMs);
      const noteText = s.note && now < s.noteUntil ? s.note : '';
      const key = `${line}|${d?.title}|${d?.detail}|${d?.retry}|${noteText}`;
      if (key === last) return;
      last = key;
      pill.textContent = line;
      pill.classList.toggle('off', s.phase !== 'playing' && s.phase !== 'watching');
      banner.style.display = d ? 'flex' : 'none';
      if (d) {
        title.textContent = d.title;
        detail.textContent = d.detail;
        retry.style.display = d.retry ? '' : 'none';
      }
      note.style.display = noteText ? '' : 'none';
      note.textContent = noteText;
    },
  };
}

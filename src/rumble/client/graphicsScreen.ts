/**
 * THE GRAPHICS ERROR SCREEN: when the game cannot draw, a full-page card
 * that says so in plain words (`graphics.ts` decides which), what to try,
 * and the technical details to copy into a message. Text only (no HTML is
 * built from strings). Replaces whatever the page showed; one per page.
 */
import { el } from './dom';
import { describeFailure, failureDetails, type GraphicsFailure } from './graphics';

const CSS = `
.rg-screen{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;background:linear-gradient(#e8f2ff,#fdf6ea);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#2b2b3a;overflow:auto}
.rg-card{max-width:560px;width:100%;background:#fff;border-radius:18px;padding:22px 24px;box-shadow:0 10px 40px #28325033}
.rg-card h1{font-size:20px;margin:0 0 8px}
.rg-card p{margin:0 0 12px}
.rg-card ol{margin:0 0 14px;padding-left:20px}
.rg-card li{margin:0 0 6px}
.rg-note{background:#eef7ee;border-radius:10px;padding:8px 12px;margin:0 0 12px}
.rg-row{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 12px}
.rg-row button{font:inherit;border:0;border-radius:10px;padding:8px 14px;cursor:pointer;background:#e7e9f3;color:#2b2b3a}
.rg-row button.main{background:#4f9a5f;color:#fff}
.rg-card details{font-size:13px}
.rg-card pre{white-space:pre-wrap;word-break:break-word;background:#f4f5f9;border-radius:10px;padding:10px;margin:8px 0 0;font:12px ui-monospace,Menlo,monospace}
`;

let shown = false;

/** Show the screen (once per page; a second failure keeps the first explanation). */
export function showGraphicsError(f: GraphicsFailure, context: { online: boolean }): void {
  if (shown) return;
  shown = true;
  const words = describeFailure(f, context);
  const details = failureDetails(f, { userAgent: navigator.userAgent, page: location.href.replace(/[?#].*$/, '') });
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const screen = el('div', 'rg-screen');
  screen.setAttribute('role', 'alert');
  const card = el('div', 'rg-card');
  card.append(el('h1', undefined, words.title), el('p', undefined, words.summary));
  if (words.note) card.append(el('p', 'rg-note', words.note));
  card.append(el('p', undefined, 'What to try:'));
  const steps = el('ol');
  for (const s of words.steps) steps.append(el('li', undefined, s));
  card.append(steps);
  const row = el('div', 'rg-row');
  const retry = el('button', 'main', 'Try again');
  retry.addEventListener('click', () => location.reload());
  const copy = el('button', undefined, 'Copy details');
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(details).then(
      () => (copy.textContent = 'Copied'),
      () => (copy.textContent = 'Select the details below to copy'),
    );
  });
  row.append(retry, copy);
  card.append(row);
  const more = el('details');
  more.append(el('summary', undefined, 'Technical details'), el('pre', undefined, details));
  card.append(more);
  screen.append(card);
  document.body.append(screen);
  // The 3D canvas and the HUD stay hidden behind it (nothing is drawn there).
  for (const id of ['scene', 'hud']) {
    const node = document.getElementById(id);
    if (node) node.style.visibility = 'hidden';
  }
  console.error(`Blobbi Rumble: graphics failed (${f.kind})\n${details}`);
}

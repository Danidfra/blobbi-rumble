/**
 * THE TOUCH CONTROLS (M12): a stick for the left thumb and three buttons
 * for the right, over the arena, reporting fingers to the pure `TouchPad`
 * (`control/touch.ts`), which `PlayerInput` merges with the keys. Nothing
 * here decides anything about play.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │                                                          │
 *   │   (stick area: the                         [Grab]        │
 *   │    lower left half)                  [Jump]   ( PUNCH )  │
 *   │      ( ◉ )                                               │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The stick FLOATS: it appears under the thumb wherever it lands in the
 * lower left, and its base trails a thumb that overshoots the rim. Phones
 * differ in size and grip, and a fixed stick punishes a thumb that lands a
 * little off (an unintended first direction); a floating one cannot be
 * missed. Its resting place is drawn faintly so a new player sees where it
 * lives.
 *
 * The buttons fire on touch-down (as keys fire on key-down), show at once
 * that they are pressed, and change their words with the moment (Throw,
 * Climb, Let go, Break free; a peel's count and cooldown when out). Every
 * finger is tracked by its pointer id, captured, and let go on lift,
 * cancel, or capture lost; the whole pad is let go when the page loses
 * focus, is hidden, turns, or the controls are hidden (a panel opened).
 * No gesture of the browser (scroll, zoom, selection, the long-press menu)
 * starts on them.
 */
import { TouchPad, touchButtons, type ButtonFace, type ButtonSlot, type TouchContext } from '../control/touch';
import { el } from './dom';

export interface TouchView {
  /** Shown and listening (touch mode, a fighter of this page's, nothing modal over the arena). */
  visible: boolean;
  context: TouchContext;
  /** Out of the round: the peels left, the cooldown, and whether throwing is allowed at all now. */
  peel?: { left: number; cooldown: number; allowed: boolean };
}

const CSS = `
  .tc { position: fixed; inset: 0; pointer-events: none; z-index: 5; display: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  .tc.on { display: block; }
  .tc * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
  .tc-zone { position: absolute; left: 0; bottom: 0; width: 48%; height: 72%; pointer-events: auto; touch-action: none; }
  .tc-base { position: absolute; border-radius: 50%; background: rgba(255,255,255,0.22); border: 2px solid rgba(255,255,255,0.75); box-shadow: 0 4px 18px rgba(40,50,80,0.18); transform: translate(-50%, -50%); pointer-events: none; transition: opacity 0.12s; }
  .tc-base.rest { opacity: 0.55; }
  .tc-knob { position: absolute; left: 50%; top: 50%; width: 46%; height: 46%; border-radius: 50%; background: rgba(255,255,255,0.92); box-shadow: 0 3px 10px rgba(40,50,80,0.28); transform: translate(-50%, -50%); }
  .tc-base.run { border-color: #ffd36b; }
  .tc-base.run .tc-knob { background: #ffe9a8; }
  .tc-btn { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: 50%; pointer-events: auto; touch-action: none; background: rgba(255,255,255,0.8); border: 2px solid rgba(255,255,255,0.95); box-shadow: 0 4px 16px rgba(40,50,80,0.22); color: #2b2b3a; font: 700 13px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.02em; transition: transform 0.05s, background 0.05s, opacity 0.15s; }
  .tc-btn .sub { font: 600 11px ui-sans-serif, system-ui, sans-serif; opacity: 0.75; }
  .tc-btn.down { transform: scale(0.9); background: #ffe9a8; }
  .tc-btn.dim { opacity: 0.38; }
  .tc-btn.hide { display: none; }
  .tc-btn.punch { background: rgba(255,214,200,0.88); }
  .tc-btn.punch.down { background: #ff9f85; }
  .tc-btn.punch.free { background: #ffe08a; animation: tc-pulse 0.6s ease-in-out infinite alternate; }
  .tc-btn.grab { background: rgba(206,232,255,0.88); }
  .tc-btn.grab.down { background: #8fc9ff; }
  .tc-btn.jump { background: rgba(214,245,220,0.88); }
  .tc-btn.jump.down { background: #92dca4; }
  @keyframes tc-pulse { from { box-shadow: 0 0 0 0 rgba(255,200,80,0.6); } to { box-shadow: 0 0 0 10px rgba(255,200,80,0); } }
`;

const SLOTS: ButtonSlot[] = ['punch', 'jump', 'grab'];

export class TouchControls {
  readonly pad: TouchPad;
  readonly root: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly base: HTMLElement;
  private readonly buttons = {} as Record<ButtonSlot, { el: HTMLElement; label: HTMLElement; sub: HTMLElement }>;
  private faces = touchButtons('waiting');
  private visible = false;
  private facesKey = '';
  private stickKey = '';
  private downKey = '';
  /** Sizes in CSS pixels, from the screen's short side (`layout`). */
  private size = { stick: 56, big: 84, small: 66, gap: 14 };

  constructor(pad = new TouchPad()) {
    this.pad = pad;
    const style = el('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = el('div', 'tc');
    this.zone = el('div', 'tc-zone');
    this.base = el('div', 'tc-base rest');
    this.base.appendChild(el('div', 'tc-knob'));
    this.root.append(this.zone, this.base);
    for (const slot of SLOTS) {
      const b = el('div', `tc-btn ${slot}`);
      const label = el('span');
      const sub = el('span', 'sub');
      b.append(label, sub);
      b.setAttribute('role', 'button');
      this.buttons[slot] = { el: b, label, sub };
      this.root.appendChild(b);
      this.listenButton(b, slot);
    }
    document.body.appendChild(this.root);
    this.listenStick();
    // Anything that takes the page away lets go of every finger.
    const release = () => this.pad.releaseAll();
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', () => document.hidden && release());
    window.addEventListener('orientationchange', release);
    window.addEventListener('resize', () => this.layout());
    // No long-press menu, selection or double-tap zoom from the controls.
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('selectstart', (e) => e.preventDefault());
    this.layout();
  }

  private listenStick() {
    const z = this.zone;
    z.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!this.visible || !this.pad.stickDown(e.pointerId, e.clientX, e.clientY)) return;
      try {
        z.setPointerCapture(e.pointerId);
      } catch {
        // A synthetic or already-gone pointer: the up / cancel events still arrive.
      }
      this.draw();
    });
    z.addEventListener('pointermove', (e) => {
      this.pad.stickMove(e.pointerId, e.clientX, e.clientY);
      this.draw();
    });
    for (const k of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      z.addEventListener(k, (e) => {
        this.pad.up(e.pointerId);
        this.draw();
      });
    }
  }

  private listenButton(b: HTMLElement, slot: ButtonSlot) {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const face = this.faces[slot];
      if (!this.visible || !face.visible) return;
      this.pad.buttonDown(e.pointerId, slot, face.role);
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        // As above.
      }
      this.draw();
    });
    for (const k of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      b.addEventListener(k, (e) => {
        this.pad.up(e.pointerId);
        this.draw();
      });
    }
  }

  /** Sizes and places from the screen: thumb-sized on a phone, never cramped on a small one, within the safe area. */
  private layout() {
    const short = Math.min(window.innerWidth, window.innerHeight);
    const big = Math.round(Math.max(68, Math.min(96, short * 0.22)));
    const small = Math.round(big * 0.78);
    const gap = Math.round(big * 0.16);
    const stick = Math.round(Math.max(44, Math.min(70, short * 0.15)));
    this.size = { stick, big, small, gap };
    this.pad.radius = stick;
    const place = (slot: ButtonSlot, d: number, right: number, bottom: number) => {
      const s = this.buttons[slot].el.style;
      s.width = s.height = `${d}px`;
      s.right = `calc(env(safe-area-inset-right, 0px) + ${right}px)`;
      s.bottom = `calc(env(safe-area-inset-bottom, 0px) + ${bottom}px)`;
    };
    const edge = Math.round(big * 0.28);
    // An arc around the big button, for a thumb that rests on it.
    place('punch', big, edge, edge);
    place('jump', small, edge + big + gap, edge + Math.round(big * 0.05));
    place('grab', small, edge + Math.round(big * 0.12), edge + big + gap);
    this.base.style.width = this.base.style.height = `${stick * 2}px`;
    this.stickKey = '';
    this.draw();
  }

  /** The stick's resting place (where it is drawn with no thumb on it). */
  private restPoint() {
    const r = this.size.stick;
    return { left: `calc(env(safe-area-inset-left, 0px) + ${Math.round(r * 1.6)}px)`, top: `calc(100% - env(safe-area-inset-bottom, 0px) - ${Math.round(r * 1.6)}px)` };
  }

  private draw() {
    const v = this.pad.stickView;
    const run = v ? this.pad.movement().run : false;
    const key = v ? `${Math.round(v.base.x)},${Math.round(v.base.y)},${Math.round(v.thumb.x)},${Math.round(v.thumb.y)},${run}` : 'rest';
    if (key !== this.stickKey) {
      this.stickKey = key;
      const s = this.base.style;
      const knob = this.base.firstElementChild as HTMLElement;
      if (v) {
        s.left = `${v.base.x}px`;
        s.top = `${v.base.y}px`;
        knob.style.transform = `translate(calc(-50% + ${v.thumb.x - v.base.x}px), calc(-50% + ${v.thumb.y - v.base.y}px))`;
      } else {
        const p = this.restPoint();
        s.left = p.left;
        s.top = p.top;
        knob.style.transform = 'translate(-50%, -50%)';
      }
      this.base.classList.toggle('rest', !v);
      this.base.classList.toggle('run', run);
    }
    const down = SLOTS.map((s) => (this.pad.isDown(s) ? 1 : 0)).join('');
    if (down !== this.downKey) {
      this.downKey = down;
      for (const s of SLOTS) this.buttons[s].el.classList.toggle('down', this.pad.isDown(s));
    }
  }

  /** Once a frame: shown or not, and the buttons' words for the moment. Cheap when nothing changed. */
  update(view: TouchView) {
    if (view.visible !== this.visible) {
      this.visible = view.visible;
      this.root.classList.toggle('on', view.visible);
      // Hidden (a panel, the rotate hint, a spectator): nothing stays held.
      if (!view.visible) this.pad.releaseAll();
    }
    if (!view.visible) return;
    const faces = touchButtons(view.context, view.peel);
    const peelText = view.context === 'out' && view.peel ? (!view.peel.allowed ? 'not now' : view.peel.left <= 0 ? 'none left' : view.peel.cooldown > 0 ? `${view.peel.cooldown.toFixed(1)} s` : `🍌 ×${view.peel.left}`) : '';
    const key = JSON.stringify([faces, peelText]);
    if (key !== this.facesKey) {
      this.facesKey = key;
      this.faces = faces;
      for (const s of SLOTS) this.paint(s, faces[s], s === 'punch' ? peelText : '');
      this.buttons.punch.el.classList.toggle('free', faces.punch.role === 'struggle');
    }
    this.draw();
  }

  private paint(slot: ButtonSlot, f: ButtonFace, sub: string) {
    const b = this.buttons[slot];
    b.label.textContent = f.label;
    b.sub.textContent = sub;
    b.el.setAttribute('aria-label', f.label);
    b.el.classList.toggle('hide', !f.visible);
    b.el.classList.toggle('dim', f.visible && !f.active);
  }
}

/**
 * Whether this page should offer touch controls: `?touch=1` / `?touch=0`
 * decide; otherwise a primary pointer that is coarse (a finger). A device
 * whose primary pointer is fine (a laptop with a touch screen) gets them
 * on its first touch instead (`watchFirstTouch`). Never from the user agent.
 */
export function prefersTouch(search: string, coarse: boolean): boolean {
  const q = new URLSearchParams(search).get('touch');
  if (q === '1') return true;
  if (q === '0') return false;
  return coarse;
}

/** Calls `on` once, at the first finger on the page (unless `?touch=0`). */
export function watchFirstTouch(search: string, on: () => void) {
  if (new URLSearchParams(search).get('touch') === '0') return;
  const f = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    window.removeEventListener('pointerdown', f, true);
    on();
  };
  window.addEventListener('pointerdown', f, true);
}

/** Whether to ask a touch player to turn the phone: portrait on a phone-sized screen, unless they chose to play on. */
export function needsRotate(v: { width: number; height: number; touch: boolean; dismissed: boolean }): boolean {
  return v.touch && !v.dismissed && v.height > v.width && Math.min(v.width, v.height) < 600;
}

/**
 * TOUCH INPUT (M12), as pure state: what a screen's fingers ask of a
 * fighter, kept apart from the DOM that reports them
 * (`client/touchControls.ts`) so every rule is tested without a browser.
 *
 * Fingers are tracked by pointer id, independently, so a thumb on the
 * stick and a thumb on the buttons never disturb each other:
 *
 *   the stick     one finger at a time owns it; its offset from the base is
 *                 the movement (`stick.ts`), until that finger lifts
 *   a button      pressed by a finger, released when that finger lifts or
 *                 is cancelled; an action fires once per press, as a key
 *                 does, and is taken by the next read (no auto-repeat)
 *   break free    a press makes one STROKE: the movement goes to one side
 *                 for a moment, and the next press to the other side. The
 *                 server counts strokes exactly as it counts a keyboard's
 *                 A-D-A-D (`combat/struggle.ts`): at most its capped rate,
 *                 so tapping faster than the cap gains nothing.
 *
 * `releaseAll` (focus lost, a modal opened, the screen turned) lets go of
 * everything at once: no finger's movement, press or stroke survives it.
 *
 * Which ROLE a button has depends on the fighter's moment (`touchContext`,
 * `touchButtons`): grab is also throw while holding someone; jump climbs
 * and grab lets go on a ledge; held, the big button breaks free; out of
 * the round, it throws a banana peel. The roles are the existing actions
 * (jump, punch, grab, and movement): no button does anything a key cannot.
 */
import type { FighterSnapshot, MatchPhase } from '../sim/snapshot';
import { NEUTRAL_STICK, STICK, dragBase, stickOutput, type StickOutput, type StickTuning } from './stick';

export type TouchAction = 'jump' | 'punch' | 'grab';
/** What pressing a button does: one of the actions, or one stroke of a struggle. */
export type TouchRole = TouchAction | 'struggle';
/** The three physical buttons, by where they sit. */
export type ButtonSlot = 'jump' | 'punch' | 'grab';

export const TOUCH = Object.freeze({
  /** A struggle stroke holds the movement to one side this long, seconds (several server ticks, so no tick misses it). */
  strokeTime: 0.09,
});

interface StickFinger {
  id: number;
  base: { x: number; y: number };
  thumb: { x: number; y: number };
}

export class TouchPad {
  /** The stick's radius in pixels (the DOM layer sets it from the screen's size). */
  radius = 56;
  private stick: StickFinger | null = null;
  /** Which finger holds which button down. */
  private readonly down = new Map<number, ButtonSlot>();
  private readonly pressed = new Set<TouchAction>();
  /** The struggle: the side of the last stroke (-1 / 1), and until when (seconds) the stroke's movement holds. */
  private strokeSide = 1;
  private strokeUntil = -Infinity;

  constructor(
    private readonly clock: () => number = () => performance.now() / 1000,
    private readonly tuning: StickTuning = STICK,
  ) {}

  /** A finger landed in the stick's area: it becomes the stick (a floating base under it), unless another finger already is. */
  stickDown(id: number, x: number, y: number): boolean {
    if (this.stick || this.down.has(id)) return false;
    this.stick = { id, base: { x, y }, thumb: { x, y } };
    return true;
  }

  /** The stick's finger moved (any other finger's move is ignored). */
  stickMove(id: number, x: number, y: number) {
    const s = this.stick;
    if (!s || s.id !== id) return;
    s.thumb = { x, y };
    s.base = dragBase(s.base, s.thumb, this.radius);
  }

  /** A finger pressed a button in role `role`: an action is requested once; a struggle press makes a stroke. */
  buttonDown(id: number, slot: ButtonSlot, role: TouchRole) {
    if (this.stick?.id === id) return;
    this.down.set(id, slot);
    if (role === 'struggle') {
      this.strokeSide = -this.strokeSide;
      this.strokeUntil = this.clock() + TOUCH.strokeTime;
    } else this.pressed.add(role);
  }

  /** A finger lifted or was cancelled: whatever it held is let go. */
  up(id: number) {
    if (this.stick?.id === id) this.stick = null;
    this.down.delete(id);
  }

  /** Let go of everything: every finger, every unread press, any stroke. */
  releaseAll() {
    this.stick = null;
    this.down.clear();
    this.pressed.clear();
    this.strokeUntil = -Infinity;
  }

  /** Whether `action` was requested since it was last taken; taking consumes it. */
  take(action: TouchAction): boolean {
    return this.pressed.delete(action);
  }

  /** The movement now (screen-relative), a struggle stroke's side taking precedence while it lasts. */
  movement(): StickOutput {
    if (this.clock() < this.strokeUntil) return { x: this.strokeSide, y: 0, magnitude: 1, run: false };
    const s = this.stick;
    if (!s) return { ...NEUTRAL_STICK };
    return stickOutput(s.thumb.x - s.base.x, s.thumb.y - s.base.y, this.radius, this.tuning);
  }

  /** For drawing: the stick's base and thumb (null: no finger on it). */
  get stickView(): { base: { x: number; y: number }; thumb: { x: number; y: number } } | null {
    if (!this.stick) return null;
    const { base, thumb } = this.stick;
    const dx = thumb.x - base.x;
    const dy = thumb.y - base.y;
    const d = Math.hypot(dx, dy);
    const k = d > this.radius ? this.radius / d : 1;
    return { base, thumb: { x: base.x + dx * k, y: base.y + dy * k } };
  }

  /** Whether some finger holds this button down (for drawing). */
  isDown(slot: ButtonSlot): boolean {
    for (const s of this.down.values()) if (s === slot) return true;
    return false;
  }

  /** How many fingers are on the controls. */
  get fingers(): number {
    return this.down.size + (this.stick ? 1 : 0);
  }
}

/** The fighter's moment, as far as the touch buttons care. */
/** L4: 'social' is the social lobby's plaza: walk and jump, nothing else. */
export type TouchContext = 'fight' | 'holding' | 'held' | 'ledge' | 'climbing' | 'out' | 'waiting' | 'social';

/** The moment of a fighter (null: none of this screen's) in a match phase. */
export function touchContext(me: FighterSnapshot | null, phase: MatchPhase, social = false): TouchContext {
  // L4: on the social lobby's plaza only walking and jumping: no combat buttons.
  if (social) return me ? 'social' : 'waiting';
  if (!me || phase !== 'playing') return 'waiting';
  if (me.eliminated) return 'out';
  if (me.heldBy) return 'held';
  if (me.ledge) return me.ledge.phase === 'climb' ? 'climbing' : 'ledge';
  if (me.holding) return 'holding';
  return 'fight';
}

export interface ButtonFace {
  role: TouchRole;
  label: string;
  /** Shown at all, and whether it does something now (a dimmed button still answers, for it is the same action as the key). */
  visible: boolean;
  active: boolean;
}

/**
 * Each button's role and face in a moment. The roles are the actions the
 * keys send in the same moment (grab again throws, jump climbs, grab lets
 * go, any action throws a peel when out), except held, where the big
 * button makes struggle strokes: the touch form of alternating ← →.
 */
export function touchButtons(ctx: TouchContext, peel?: { left: number; cooldown: number; allowed: boolean }): Record<ButtonSlot, ButtonFace> {
  const face = (role: TouchRole, label: string, active = true, visible = true): ButtonFace => ({ role, label, active, visible });
  switch (ctx) {
    case 'holding':
      return { punch: face('punch', 'Punch'), jump: face('jump', 'Jump', false), grab: face('grab', 'Throw') };
    case 'held':
      return { punch: face('struggle', 'Break free'), jump: face('jump', 'Jump', false), grab: face('grab', 'Grab', false) };
    case 'ledge':
      return { punch: face('punch', 'Punch', false), jump: face('jump', 'Climb'), grab: face('grab', 'Let go') };
    case 'climbing':
      // M12.1: the climb runs by itself; nothing to press until it is over.
      return { punch: face('punch', 'Punch', false), jump: face('jump', 'Climbing…', false), grab: face('grab', 'Let go', false) };
    case 'out': {
      const ready = !!peel && peel.allowed && peel.left > 0 && peel.cooldown <= 0;
      return { punch: face('punch', 'Throw', ready), jump: face('jump', 'Jump', false, false), grab: face('grab', 'Grab', false, false) };
    }
    case 'waiting':
      return { punch: face('punch', 'Punch', false), jump: face('jump', 'Jump', false), grab: face('grab', 'Grab', false) };
    case 'social':
      // L4: no combat on the plaza: the combat buttons are not shown at all.
      return { punch: face('punch', 'Punch', false, false), jump: face('jump', 'Jump'), grab: face('grab', 'Grab', false, false) };
    default:
      return { punch: face('punch', 'Punch'), jump: face('jump', 'Jump'), grab: face('grab', 'Grab') };
  }
}

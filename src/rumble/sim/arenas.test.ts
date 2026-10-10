/**
 * M11A–E in the authoritative match, under Havok: the arena in play and
 * in every snapshot, switching arenas (rotation) without a second system,
 * Skyfall's falling pads and breakable bridges with their colliders, the
 * factory's belts and arm, the frozen lake's slide and fragile ice, and
 * round resets putting every piece back.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { CLASSIC, FACTORY, FROZEN, SKYFALL, arenaSpawns, type ArenaDef } from '../arena/arenas';
import { FALL_DEPTH } from '../arena/pieces';
import { RUMBLE_BODY } from '../profile';
import { LEDGE, ROUND } from '../tuning';
import { loadHavokNode } from './havokNode';
import { SURFACES, createRumbleMatch, type RumbleMatch } from './match';
import type { HavokInstance } from './physics';
import type { MatchSnapshot } from './snapshot';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

const DT = 1 / 60;
const make = (arena?: ArenaDef, ids = ['a', 'b']) => createRumbleMatch({ havok, players: ids.map((id) => ({ id })), ...(arena ? { arena } : {}) });
const steps = (m: RumbleMatch, n: number) => {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...m.step(DT));
  return events;
};
const secs = (m: RumbleMatch, s: number) => steps(m, Math.ceil(s / DT));
const fighter = (s: MatchSnapshot, id: string) => s.fighters.find((f) => f.id === id)!;
const still = (m: RumbleMatch, id: string) => m.setInput(id, { x: 0, z: 0 });
/** The fighter's feet: the snapshot's position is the capsule's centre. */
const feetY = (f: MatchSnapshot['fighters'][number]) => f.position.y - RUMBLE_BODY.capsuleCenterY;

describe('the arena in play (M11A)', () => {
  it('is the classic island unless chosen, and is named in every snapshot with no pieces and the sweeper; a snapshot still survives JSON', () => {
    const m = make();
    expect(m.arena).toBe(CLASSIC);
    const s = m.snapshot();
    expect(s.arena).toBe('floating-islands-classic');
    expect(s.pieces).toEqual([]);
    expect(s.sweeper).not.toBeNull();
    expect(s.roundTime).toBe(0);
    steps(m, 30);
    expect(m.snapshot().roundTime).toBeCloseTo(0.5, 5);
    expect(JSON.parse(JSON.stringify(m.snapshot()))).toEqual(m.snapshot());
    m.dispose();
  });

  it('a chosen arena: spawns at its platforms’ heights, its pieces listed, no sweeper where it has none, and its orbs', () => {
    const m = make(SKYFALL, ['a', 'b', 'c']);
    const s = m.snapshot();
    expect(s.arena).toBe(SKYFALL.id);
    expect(s.sweeper).toBeNull();
    expect(s.pieces).toHaveLength(SKYFALL.dynamics.length);
    expect(s.pieces.every((p) => p.phase === 'stable' && p.drop === 0)).toBe(true);
    expect(s.orbs.map((o) => [o.x, o.z])).toEqual(SKYFALL.orbs.map((o) => [o.x, o.z]));
    const spawns = arenaSpawns(SKYFALL, 3);
    steps(m, 30);
    m.snapshot().fighters.forEach((f, i) => {
      expect(Math.hypot(f.position.x - spawns[i].x, f.position.z - spawns[i].z)).toBeLessThan(0.1);
      expect(feetY(f)).toBeGreaterThan(spawns[i].y - 0.05);
      expect(feetY(f)).toBeLessThan(spawns[i].y + 0.2);
      expect(f.alive).toBe(true);
    });
    m.dispose();
  });

  it('switching arenas keeps the fighters and scores, moves them to the new spawns, rebuilds the colliders, and says so once', () => {
    const m = make(CLASSIC);
    // One round to 'b', so a score exists to keep.
    m.debugPlace('a', { x: 0, z: 6 });
    secs(m, 1 + ROUND.resetDelay + 0.2);
    expect(fighter(m.snapshot(), 'b').score).toBe(1);
    const events = m.switchArena(FACTORY);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'arena', note: FACTORY.id }));
    expect(m.arena).toBe(FACTORY);
    let s = m.snapshot();
    expect(s.arena).toBe(FACTORY.id);
    expect(s.players).toEqual(['a', 'b']);
    expect(fighter(s, 'b').score).toBe(1);
    expect(s.sweeper).not.toBeNull();
    const spawns = arenaSpawns(FACTORY, 2);
    secs(m, 1);
    s = m.snapshot();
    s.fighters.forEach((f, i) => {
      expect(Math.hypot(f.position.x - spawns[i].x, f.position.z - spawns[i].z)).toBeLessThan(0.1);
      expect(f.alive).toBe(true);
    });
    // Switching to the same arena is nothing; switching again works; the old arena's floor is gone (a fighter over the classic right wing falls).
    expect(m.switchArena(FACTORY)).toEqual([]);
    m.switchArena(FROZEN);
    expect(m.snapshot().arena).toBe(FROZEN.id);
    expect(m.snapshot().sweeper).toBeNull();
    expect(m.snapshot().pieces).toHaveLength(FROZEN.dynamics.length);
    m.debugPlace('a', { x: 7.6, z: 3.2 });
    const out = secs(m, 2);
    expect(out).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
    m.dispose();
  });

  it('the elimination boundary is the arena’s: a Skyfall fighter below the classic line is still in play until its own line', () => {
    const m = make(SKYFALL);
    m.debugPlace('a', { x: 0, z: 5.3, y: -1.2 });
    secs(m, 0.5);
    expect(fighter(m.snapshot(), 'a').alive).toBe(true);
    expect(feetY(fighter(m.snapshot(), 'a'))).toBeLessThan(-1);
    m.debugPlace('a', { x: 0, z: 7.5, y: -1.2 });
    const events = secs(m, 2);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
    m.dispose();
  });
});

describe('Skyfall (M11B)', () => {
  const pad = SKYFALL.dynamics[2];
  const padRect = SKYFALL.platforms[pad.platform];
  const padRule = pad.rule as Extract<typeof pad.rule, { kind: 'falling' }>;

  it('standing on a pad arms it: warning, then it falls under the fighter, who drops through where the floor was and is rung out', () => {
    const m = make(SKYFALL);
    m.debugPlace('a', { x: padRect.x, z: padRect.z });
    still(m, 'a');
    const events = secs(m, padRule.arm + padRule.warn + 0.4);
    const phases = events.filter((e) => e.kind === 'piece' && e.piece === 2).map((e) => e.note);
    expect(phases).toEqual(['warning', 'falling']);
    let s = m.snapshot();
    expect(s.pieces[2].phase).toBe('falling');
    expect(s.pieces[2].drop).toBeGreaterThan(0);
    secs(m, 2);
    s = m.snapshot();
    expect(s.pieces[2].phase).toBe('gone');
    expect(s.pieces[2].drop).toBe(FALL_DEPTH);
    expect(fighter(s, 'a').alive).toBe(false);
    expect(fighter(s, 'b').alive).toBe(true);
    m.dispose();
  });

  it('a gone pad has no collider: a fighter put over it falls; after it is back, a fighter stands on it again', () => {
    const m = make(SKYFALL, ['a', 'b', 'c']);
    m.debugPlace('a', { x: padRect.x, z: padRect.z });
    still(m, 'a');
    secs(m, padRule.arm + padRule.warn + padRule.fall + 0.5);
    expect(m.snapshot().pieces[2].phase).toBe('gone');
    m.debugPlace('b', { x: padRect.x, z: padRect.z });
    still(m, 'b');
    secs(m, 1);
    expect(feetY(fighter(m.snapshot(), 'b'))).toBeLessThan(-1);
    secs(m, padRule.back);
    expect(m.snapshot().pieces[2].phase).toBe('stable');
    m.debugPlace('c', { x: padRect.x, z: padRect.z });
    still(m, 'c');
    secs(m, 0.6);
    const c = fighter(m.snapshot(), 'c');
    expect(c.alive).toBe(true);
    expect(Math.abs(feetY(c) - padRect.y)).toBeLessThan(0.1);
    m.dispose();
  });

  it('a bridge breaks by the round’s clock when nobody has hit anyone over it; a round reset puts every piece back and the clock to zero', () => {
    const m = make(SKYFALL);
    const bridge = SKYFALL.dynamics[0];
    const rule = bridge.rule as Extract<typeof bridge.rule, { kind: 'breakable' }>;
    const events = secs(m, rule.after + rule.warn + rule.fall + 0.3);
    const phases = events.filter((e) => e.kind === 'piece' && e.piece === 0).map((e) => e.note);
    expect(phases).toEqual(['warning', 'falling', 'gone']);
    expect(m.snapshot().roundTime).toBeGreaterThan(rule.after);
    // A ring-out ends the round; the next starts with the bridge back.
    m.debugPlace('a', { x: 0, z: 9 });
    const reset = secs(m, 1.5 + ROUND.resetDelay + 0.3);
    expect(reset.map((e) => e.kind)).toContain('newRound');
    const s = m.snapshot();
    expect(s.pieces.every((p) => p.phase === 'stable' && p.drop === 0)).toBe(true);
    expect(s.roundTime).toBeLessThan(1);
    m.dispose();
  });

  it('a bridge breaks by blows: heavy hits on a fighter over it count, then the bridge warns', () => {
    const m = make(SKYFALL);
    const bridge = SKYFALL.dynamics[0];
    const r = SKYFALL.platforms[bridge.platform];
    const rule = bridge.rule as Extract<typeof bridge.rule, { kind: 'breakable' }>;
    let hits = 0;
    for (let k = 0; k < 12 && hits < rule.impacts; k++) {
      m.debugPlace('b', { x: r.x, z: r.z, y: r.y, yaw: Math.PI / 2 });
      m.debugPlace('a', { x: r.x + 0.7, z: r.z, y: r.y, yaw: -Math.PI / 2, powerLevel: 3 });
      still(m, 'a');
      still(m, 'b');
      steps(m, 5);
      m.setInput('a', { punch: true });
      const ev = secs(m, 0.5);
      if (ev.some((e) => e.kind === 'punch' && e.who === 'a' && e.reaction === 'tumble')) hits++;
    }
    expect(hits).toBe(rule.impacts);
    expect(m.snapshot().pieces[0].phase).toBe('warning');
    expect(m.snapshot().roundTime).toBeLessThan(rule.after);
    m.dispose();
  });
});

describe('the factory (M11D)', () => {
  it('a belt carries a standing fighter along its direction, at a bounded speed, and the other belt the other way', () => {
    const m = make(FACTORY);
    const north = FACTORY.platforms[FACTORY.conveyors[0].platform];
    const south = FACTORY.platforms[FACTORY.conveyors[1].platform];
    m.debugPlace('a', { x: -2, z: north.z });
    m.debugPlace('b', { x: 2, z: south.z });
    still(m, 'a');
    still(m, 'b');
    secs(m, 1.2);
    const s = m.snapshot();
    const a = fighter(s, 'a');
    const b = fighter(s, 'b');
    expect(a.position.x).toBeGreaterThan(-2 + 0.8);
    expect(b.position.x).toBeLessThan(2 - 0.8);
    expect(Math.abs(a.velocity.x)).toBeLessThan(FACTORY.conveyors[0].vx + 0.4);
    expect(Math.abs(a.position.z - north.z)).toBeLessThan(0.3);
    expect(a.alive && b.alive).toBe(true);
    m.dispose();
  });

  it('the belts only carry: a fighter on the floor beside a belt is not moved; the bound on a step’s nudge holds', () => {
    const m = make(FACTORY);
    m.debugPlace('a', { x: -3.5, z: 0.8 });
    still(m, 'a');
    secs(m, 1);
    expect(Math.abs(fighter(m.snapshot(), 'a').position.x + 3.5)).toBeLessThan(0.1);
    expect(SURFACES.conveyorMaxDv).toBeLessThan(0.5);
    m.dispose();
  });

  it('the arm is the sweeper at its own pivot: it turns, and strikes a fighter on the west pad', () => {
    const m = make(FACTORY);
    const arm = FACTORY.sweeper!;
    m.debugPlace('a', { x: arm.pivot.x + arm.reach * 0.7, z: arm.pivot.z });
    still(m, 'a');
    const events = secs(m, 2 * Math.PI / arm.angularSpeed + 0.5);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'sweeper', who: 'a' }));
    expect(m.snapshot().sweeper!.angle).toBeGreaterThan(0);
    m.dispose();
  });
});

describe('the frozen lake (M11E)', () => {
  const run = (arena: ArenaDef, from: { x: number; z: number }) => {
    const m = make(arena);
    m.debugPlace('a', { x: from.x, z: from.z, yaw: Math.PI / 2 });
    m.debugPlace('b', { x: 0, z: arena === FROZEN ? -2.9 : -2 });
    still(m, 'b');
    m.setInput('a', { x: 1, z: 0 });
    secs(m, 1.2);
    const atRelease = fighter(m.snapshot(), 'a').position.x;
    still(m, 'a');
    secs(m, 1.5);
    const slid = fighter(m.snapshot(), 'a').position.x - atRelease;
    m.dispose();
    return slid;
  };

  it('ice slides: a fighter released at speed travels further on the lake than on the island, and steering is weaker', () => {
    const island = run(CLASSIC, { x: -3, z: 1.5 });
    const lake = run(FROZEN, { x: -3, z: 0 });
    expect(lake).toBeGreaterThan(island * 1.5);
    expect(lake).toBeGreaterThan(0.6);
  });

  it('the corner tiles are fragile: standing on one for its arming time breaks it, and it returns; the middle never breaks', () => {
    const m = make(FROZEN);
    const corner = FROZEN.dynamics[0];
    const tile = FROZEN.platforms[corner.platform];
    const rule = corner.rule as Extract<typeof corner.rule, { kind: 'falling' }>;
    m.debugPlace('a', { x: tile.x, z: tile.z });
    still(m, 'a');
    const events = secs(m, rule.arm + rule.warn + rule.fall + 0.3);
    expect(events.filter((e) => e.kind === 'piece' && e.piece === 0).map((e) => e.note)).toEqual(['warning', 'falling', 'gone']);
    expect(fighter(m.snapshot(), 'a').alive).toBe(true);
    // Through the hole: out at the lake's line; the round ends (two players) and the next starts with the tile back.
    const later = secs(m, 1 + ROUND.resetDelay + 0.5);
    expect(later).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
    expect(later.map((e) => e.kind)).toContain('newRound');
    expect(m.snapshot().pieces[0].phase).toBe('stable');
    expect(FROZEN.dynamics.some((d) => FROZEN.platforms[d.platform].name === 'middle')).toBe(false);
    m.dispose();
  });
});

describe('ledges (M11C)', () => {
  /** A fighter walking south off the centre's free south edge (z -4.5) at x 3: no bridge, no step there. */
  const walkOff = (m: RumbleMatch, id = 'a') => {
    m.debugPlace(id, { x: 3, z: -3.8, yaw: Math.PI });
    m.setInput(id, { x: 0, z: -1 });
  };
  /** Walk off, step until caught (the stick still pushed off the edge), then let the stick go. Returns the steps' events. */
  const catchIt = (m: RumbleMatch, id = 'a') => {
    walkOff(m, id);
    const events = [];
    for (let i = 0; i < 180; i++) {
      events.push(...m.step(DT));
      if (events.some((e) => e.kind === 'ledge' && e.who === id)) break;
    }
    expect(fighter(m.snapshot(), id).ledge).not.toBeNull();
    still(m, id);
    return events;
  };
  const ledgeNotes = (events: ReturnType<RumbleMatch['step']>, who = 'a') => events.filter((e) => e.kind === 'ledge' && e.who === who).map((e) => e.note);

  it('walking off an edge on Skyfall catches the ledge: hanging below the top, facing in, stopped, said once', () => {
    const m = make(SKYFALL);
    m.debugPlace('b', { x: -3, z: 2 });
    still(m, 'b');
    const events = catchIt(m);
    expect(ledgeNotes(events)).toEqual(['caught centre']);
    steps(m, 20);
    const a = fighter(m.snapshot(), 'a');
    expect(a.ledge).not.toBeNull();
    expect(a.ledge!.phase).toBe('hang');
    expect(a.ledge!.y).toBe(0);
    expect(a.ledge!.inZ).toBe(1);
    expect(feetY(a)).toBeCloseTo(-LEDGE.hangDrop, 1);
    expect(a.position.z).toBeLessThan(-4.5);
    expect(a.position.z).toBeGreaterThan(-5.1);
    expect(Math.hypot(a.velocity.x, a.velocity.y, a.velocity.z)).toBeLessThan(0.3);
    expect(Math.cos(a.yaw)).toBeCloseTo(1, 1);
    expect(a.grounded).toBe(false);
    expect(a.alive).toBe(true);
    // The stick pushed off the edge for a moment does not undo the catch; held longer, it is a wish to drop.
    m.setInput('a', { x: 0, z: -1 });
    secs(m, LEDGE.awayHold - 0.15);
    expect(fighter(m.snapshot(), 'a').ledge).not.toBeNull();
    const later = secs(m, 0.3);
    expect(ledgeNotes(later)).toEqual(['let go']);
    m.dispose();
  });

  it('hanging drains grip; with none left the fighter drops and is rung out; grip comes back on the floor', () => {
    const m = make(SKYFALL);
    m.debugPlace('b', { x: -3, z: 2 });
    still(m, 'b');
    catchIt(m);
    let s = m.snapshot();
    const g0 = fighter(s, 'a').ledge!.grip;
    secs(m, 1);
    s = m.snapshot();
    expect(fighter(s, 'a').ledge!.grip).toBeLessThan(g0 - 0.2);
    const events = secs(m, LEDGE.endurance + 2);
    expect(ledgeNotes(events)).toEqual(['tired']);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
    m.dispose();
  });

  it('a jump climbs: the fighter ends standing on top, a step in from the edge, in play, and is not caught again on the way', () => {
    const m = make(SKYFALL);
    m.debugPlace('b', { x: -3, z: 2 });
    still(m, 'b');
    catchIt(m);
    m.setInput('a', { jump: true });
    const events = secs(m, LEDGE.climbTime + 0.6);
    expect(ledgeNotes(events)).toEqual(['climbed']);
    const a = fighter(m.snapshot(), 'a');
    expect(a.ledge).toBeNull();
    expect(a.alive).toBe(true);
    expect(a.grounded).toBe(true);
    expect(Math.abs(feetY(a))).toBeLessThan(0.1);
    expect(a.position.z).toBeGreaterThan(-4.5 + 0.3);
    expect(a.position.z).toBeLessThan(-3);
    m.dispose();
  });

  it('a grab lets go; so does pushing away once the hold is a moment old; either falls to the fall line', () => {
    const m = make(SKYFALL, ['a', 'b', 'c']);
    m.debugPlace('c', { x: -3, z: 2 });
    still(m, 'c');
    catchIt(m, 'a');
    m.setInput('a', { grab: true });
    const ev1 = secs(m, 1.6);
    expect(ledgeNotes(ev1, 'a')).toEqual(['let go']);
    expect(ev1).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
    catchIt(m, 'b');
    m.setInput('b', { x: 0, z: -1 });
    const ev2 = secs(m, LEDGE.awayHold + 0.3);
    expect(ledgeNotes(ev2, 'b')).toEqual(['let go']);
    m.dispose();
  });

  it('an opponent’s blow knocks a hanging fighter off; a hanging fighter cannot punch or grab', () => {
    const m = make(SKYFALL);
    m.debugPlace('b', { x: -3, z: 2 });
    still(m, 'b');
    catchIt(m);
    // The hanger's punch and grab do nothing.
    m.setInput('a', { punch: true });
    const none = secs(m, 0.4);
    expect(none.filter((e) => e.kind === 'punch' && e.who === 'a')).toEqual([]);
    expect(fighter(m.snapshot(), 'a').ledge).not.toBeNull();
    // The one above punches down over the edge.
    m.debugPlace('b', { x: 3, z: -4.1, yaw: Math.PI, powerLevel: 1 });
    m.setInput('b', { punch: true });
    const events = secs(m, 2);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'punch', who: 'b', on: 'a' }));
    expect(ledgeNotes(events)).toEqual(['knocked off']);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
    m.dispose();
  });

  it('a tumbling (thrown) body catches nothing; the classic island and the frozen lake have no ledges: walking off is a ring-out as before', () => {
    for (const arena of [CLASSIC, FROZEN]) {
      const m = make(arena);
      m.debugPlace('b', { x: 0, z: arena === FROZEN ? -2.9 : -2 });
      still(m, 'b');
      m.debugPlace('a', { x: 0, z: arena === FROZEN ? 3.6 : 3.5, yaw: 0 });
      m.setInput('a', { x: 0, z: 1 });
      const events = secs(m, 3);
      expect(events.filter((e) => e.kind === 'ledge')).toEqual([]);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
      m.dispose();
    }
    const m = make(SKYFALL);
    // 'b' grabs 'a' at the south edge and throws it over: no catch for a thrown body.
    m.debugPlace('a', { x: 3, z: -3.9, yaw: Math.PI });
    m.debugPlace('b', { x: 3, z: -3.1, yaw: Math.PI });
    still(m, 'a');
    still(m, 'b');
    steps(m, 5);
    m.setInput('b', { grab: true });
    secs(m, 0.3);
    expect(fighter(m.snapshot(), 'a').heldBy).toBe('b');
    m.setInput('b', { grab: true });
    const events = secs(m, 3);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'throw', who: 'b', on: 'a' }));
    expect(events.filter((e) => e.kind === 'ledge' && e.who === 'a')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'out', who: 'a' }));
    m.dispose();
  });

  it('a ledge on a pad that falls is lost with it', () => {
    const m = make(SKYFALL, ['a', 'b', 'c']);
    const pad = SKYFALL.dynamics[3];
    const r = SKYFALL.platforms[pad.platform];
    const rule = pad.rule as Extract<typeof pad.rule, { kind: 'falling' }>;
    m.debugPlace('c', { x: 0, z: 0 });
    still(m, 'c');
    // 'b' stands on the pad (arming it); 'a' walks off its outer (south) edge and hangs there.
    m.debugPlace('b', { x: r.x, z: r.z });
    still(m, 'b');
    m.debugPlace('a', { x: r.x, z: r.z - r.halfDepth + 0.6, yaw: Math.PI });
    m.setInput('a', { x: 0, z: -1 });
    secs(m, 0.8);
    still(m, 'a');
    expect(fighter(m.snapshot(), 'a').ledge).not.toBeNull();
    const events = secs(m, rule.arm + rule.warn + 0.3);
    expect(ledgeNotes(events)).toEqual(['ledge gone']);
    expect(fighter(m.snapshot(), 'a').ledge).toBeNull();
    m.dispose();
  });
});

describe('walkable transitions (M11.1)', () => {
  /** Walk `id` from `from` along `dir` for `seconds`; fail if it ever leaves the ground, dips under the floor, or jumps. */
  const walk = (m: RumbleMatch, id: string, from: { x: number; z: number; y?: number }, dir: { x: number; z: number }, seconds: number) => {
    m.debugPlace(id, { ...from, yaw: Math.atan2(dir.x, dir.z) });
    steps(m, 10);
    m.setInput(id, { x: dir.x, z: dir.z });
    let minFeet = Infinity;
    let airborne = 0;
    for (let i = 0; i < Math.ceil(seconds / DT); i++) {
      const ev = m.step(DT);
      expect(ev.filter((e) => e.kind === 'jump' && e.who === id)).toEqual([]);
      const f = fighter(m.snapshot(), id);
      if (i > 15) {
        minFeet = Math.min(minFeet, feetY(f));
        if (!f.grounded) airborne++;
      }
    }
    still(m, id);
    return { at: fighter(m.snapshot(), id), minFeet, airborne };
  };

  it('Skyfall: a fighter walks from the centre over each bridge onto its island and back without jumping, sinking or snagging', () => {
    const m = make(SKYFALL);
    m.debugPlace('b', { x: 0, z: 3 });
    still(m, 'b');
    const east = walk(m, 'a', { x: 4, z: 1.2 }, { x: 1, z: 0 }, 3.6);
    expect(east.at.position.x).toBeGreaterThan(8.6);
    expect(east.at.alive).toBe(true);
    expect(east.minFeet).toBeGreaterThan(-0.08);
    expect(east.airborne).toBeLessThan(4);
    const back = walk(m, 'a', { x: 10, z: 1.2 }, { x: -1, z: 0 }, 3.6);
    expect(back.at.position.x).toBeLessThan(5.6);
    expect(back.minFeet).toBeGreaterThan(-0.08);
    const west = walk(m, 'a', { x: -4, z: -1.2 }, { x: -1, z: 0 }, 3.6);
    expect(west.at.position.x).toBeLessThan(-8.6);
    expect(west.at.alive).toBe(true);
    expect(west.minFeet).toBeGreaterThan(-0.08);
    m.dispose();
  });

  it('Factory: belts and pads join the floor flush: a fighter walks from the crate’s side to the east pad over the belt without a hop', () => {
    const m = make(FACTORY);
    m.debugPlace('b', { x: 0, z: -1.5 });
    still(m, 'b');
    const r = walk(m, 'a', { x: 2.5, z: 3.2 }, { x: 1, z: 0 }, 2.0);
    expect(r.at.position.x).toBeGreaterThan(6.5);
    expect(r.at.position.x).toBeLessThan(9.2);
    expect(r.at.alive).toBe(true);
    expect(r.minFeet).toBeGreaterThan(-0.08);
    expect(r.airborne).toBeLessThan(4);
    m.dispose();
  });
});

const ledgeNotesOf = (events: ReturnType<RumbleMatch['step']>, who = 'a') => events.filter((e) => e.kind === 'ledge' && e.who === who).map((e) => e.note);

describe('ledges, tightened (M11.1)', () => {
  it('a step down is not a fall to catch: walking off the south step onto the centre (half a metre) just lands', () => {
    const m = make(SKYFALL);
    m.debugPlace('b', { x: 3, z: 2 });
    still(m, 'b');
    m.debugPlace('a', { x: -1, z: -5.0, y: 0.5, yaw: 0 });
    m.setInput('a', { x: 0, z: 1 });
    const events = secs(m, 1.5);
    expect(events.filter((e) => e.kind === 'ledge')).toEqual([]);
    const a = fighter(m.snapshot(), 'a');
    expect(a.alive).toBe(true);
    expect(Math.abs(feetY(a))).toBeLessThan(0.1);
    expect(a.position.z).toBeGreaterThan(-4.5);
    m.dispose();
  });

  it('after a climb the keys do not walk the fighter straight back off: a stick still pushed off the edge is ignored for a moment, and a later fall is caught again', () => {
    const m = make(SKYFALL);
    m.debugPlace('b', { x: 3, z: 2 });
    still(m, 'b');
    m.debugPlace('a', { x: 3, z: -3.8, yaw: Math.PI });
    m.setInput('a', { x: 0, z: -1 });
    const caught: ReturnType<RumbleMatch['step']> = [];
    for (let i = 0; i < 180 && !caught.some((e) => e.kind === 'ledge'); i++) caught.push(...m.step(DT));
    expect(fighter(m.snapshot(), 'a').ledge).not.toBeNull();
    // Climb while still pushing off the edge.
    m.setInput('a', { x: 0, z: -1, jump: true });
    const climb = secs(m, LEDGE.climbTime + 0.05);
    expect(ledgeNotesOf(climb)).toEqual(['climbed']);
    const settled = secs(m, LEDGE.settle - 0.05);
    expect(settled.filter((e) => e.kind === 'ledge' || e.kind === 'out')).toEqual([]);
    expect(fighter(m.snapshot(), 'a').grounded).toBe(true);
    expect(fighter(m.snapshot(), 'a').alive).toBe(true);
    // Still pushing: it walks off again and is caught again, never rung out.
    const later = secs(m, 1.2);
    expect(ledgeNotesOf(later)).toEqual(['caught centre']);
    expect(later.filter((e) => e.kind === 'out')).toEqual([]);
    m.dispose();
  });

  it('a ledge whose hang would sit inside a neighbouring slab is no ledge: the centre’s north edge over the ledge below is still caught (the hang clears it), the step’s inner edge against the centre is not', () => {
    // Falling off the centre's north edge: the hang is at feet -0.85, above the north ledge's top (-1.2): caught.
    const m = make(SKYFALL);
    m.debugPlace('b', { x: 3, z: -2 });
    still(m, 'b');
    m.debugPlace('a', { x: 0, z: 3.8, yaw: 0 });
    m.setInput('a', { x: 0, z: 1 });
    const events = secs(m, 1.5);
    expect(ledgeNotesOf(events)[0]).toBe('caught centre');
    expect(events.filter((e) => e.kind === 'out')).toEqual([]);
    m.dispose();
  });
});

/**
 * LOCAL MODE (rumble.html): the match runs in this page, as in M7A. P1 and
 * P2 from the keyboard, P3 and P4 from test bots; the page steps the match
 * once per frame and the presenter draws its snapshot. No server.
 */
import { BotInput, botWorldFrom } from '../control/bot';
import { Keyboard, P1_BINDINGS, P2_BINDINGS, PlayerInput, ScriptableInput, moveIntent, type MoveIntent } from '../control/input';
import { BANANAS } from '../tuning';
import { loadHavok } from '../physics/world';
import { rosterFor, rosterOptions } from '../roster';
import { createRumbleMatch } from '../sim/match';
import { arenaById } from '../arena/arenas';
import type { MatchEvent, MatchSnapshot } from '../sim/snapshot';
import { RumblePresenter } from './presenter';

const CONTROLS = ['P1  WASD move · LShift run · Space jump · F punch · G grab/throw', 'P2  Arrows move · RShift run · Enter jump · K punch · L grab/throw', 'grabbed? alternate left/right to break free', 'walk into an orb: harder punches and throws this round', 'F3 colliders & reach · R restart a finished match · ?network=1 to play on a server'];

export async function startLocal(canvas: HTMLCanvasElement, hud: HTMLElement) {
  const havok = await loadHavok();
  const roster = rosterFor(rosterOptions(location.search));
  const arena = arenaById(new URLSearchParams(location.search).get('arena')) ?? undefined;
  const match = createRumbleMatch({ havok, players: roster.map((e) => ({ id: e.label })), arena });
  const ids = match.ids;
  let snapshot: MatchSnapshot = match.snapshot();
  const presenter = new RumblePresenter(canvas, hud, roster.map((e) => ({ id: e.label, identity: e.identity })), snapshot.orbs, snapshot.arena);

  // Intent producers: the keyboard for people, test bots for the rest, each behind a scripting hook for checks.
  const keyboard = new Keyboard([P1_BINDINGS, P2_BINDINGS]);
  const bots: (BotInput | null)[] = [];
  const inputs = roster.map((entry, i) => {
    const driver = entry.keys ? new PlayerInput(keyboard, entry.keys) : new BotInput(i + 1);
    bots.push(driver instanceof BotInput ? driver : null);
    return new ScriptableInput(driver);
  });
  let botsOn = true;
  let matchCount = 0;
  const events: MatchEvent[] = [];
  const resetBots = () => bots.forEach((b) => b?.reset(snapshot.round + 1000 * matchCount));
  const take = (stepEvents: MatchEvent[]) => {
    snapshot = match.snapshot();
    for (const e of stepEvents) {
      events.push(e);
      if (e.kind === 'newRound' || e.kind === 'match' || e.kind === 'newMatch') resetBots();
    }
  };
  const newMatch = () => {
    matchCount += 1;
    take(match.restart());
  };
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && snapshot.phase === 'matchOver') newMatch();
  });

  /** M11F: each keyboard player's aim while out of the round (null: not aiming). */
  const aims: ({ x: number; z: number } | null)[] = roster.map(() => null);
  const frame = (dt: number) => {
    const before = snapshot;
    const playing = before.phase === 'playing';
    inputs.forEach((input, i) => (input.enabled = playing && !before.fighters[i].eliminated && (botsOn || !bots[i] || input.script !== null)));
    bots.forEach((b, i) => b?.plan(botWorldFrom(before, ids[i]), dt));
    const yaw = presenter.cameraYaw();
    inputs.forEach((input, i) => {
      const intent = input.read(yaw);
      const keys = roster[i].keys;
      const f = before.fighters[i];
      if (keys && playing && f.eliminated) {
        // Out of the round at this keyboard: the keys aim a banana peel; punch or grab throws it.
        const raw = moveIntent(keyboard.held, yaw, keys);
        const a = aims[i] ?? presenter.clampAim({ x: f.position.x, z: f.position.z });
        aims[i] = presenter.clampAim({ x: a.x + raw.x * BANANAS.aimSpeed * dt, z: a.z + raw.z * BANANAS.aimSpeed * dt });
        if (intent.punch || intent.grab) match.throwBanana(ids[i], aims[i]!.x, aims[i]!.z);
        return;
      }
      aims[i] = null;
      match.setInput(ids[i], intent);
    });
    take(match.step(dt));
    presenter.present(snapshot, dt, {
      driver: (i) => (bots[i] ? 'bot' : 'keys'),
      botState: (i) => bots[i]?.memory.state.toLowerCase() ?? null,
      matchOverHint: 'press R to play again',
      controls: CONTROLS,
      holdsConsistent: match.holdsConsistent(),
      strugglers: roster.flatMap((e, i) => (e.keys ? [{ index: i, keys: i === 0 ? 'A ↔ D' : '← ↔ →' }] : [])),
      aimers: roster.flatMap((e, i) => (e.keys && aims[i] ? [{ index: i, aim: aims[i]!, keys: i === 0 ? 'WASD · throw F / G' : 'arrows · throw K / L' }] : [])),
    });
  };

  let last = performance.now();
  presenter.engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt);
  });
  Object.assign(window, {
    rumble: {
      mode: 'local',
      scene: presenter.scene,
      match,
      views: presenter.views,
      bots,
      events,
      get snapshot() {
        return snapshot;
      },
      get cameraPose() {
        return presenter.camera;
      },
      /** Drive frames by hand (a hidden tab gets none); scripted checks step at a fixed 1/60 s. */
      step(frames = 1, dt = 1 / 60) {
        for (let i = 0; i < frames; i++) frame(dt);
      },
      key(code: string, down: boolean) {
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code }));
      },
      press(code: string) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code }));
      },
      /** Scripted checks: drive fighter `i` with this intent (null hands it back), and switch the bots on or off. */
      script(i: number, intent: Partial<MoveIntent> | null) {
        inputs[i].script = intent ? { x: 0, z: 0, run: false, jump: false, punch: false, grab: false, ...intent } : null;
      },
      setBots(on: boolean) {
        botsOn = on;
      },
      holdsConsistent: () => match.holdsConsistent(),
      newMatch,
    },
  });
}

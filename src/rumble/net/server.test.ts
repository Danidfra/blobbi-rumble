/**
 * The server over real WebSockets: slots, bots in the empty ones, the
 * trust boundary on input, one-shot requests that survive until a step
 * takes them, acknowledgements, ordered states, disconnects and the input
 * timeout. Most tests step the match by hand (`manual`) so what each step
 * sees is exact; one runs the real 60 Hz clock.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RUMBLE_BODY } from '../profile';
import { loadHavokNode } from '../sim/havokNode';
import type { HavokInstance } from '../sim/physics';
import type { MatchSnapshot } from '../sim/snapshot';
import { NET } from './host';
import type { ServerMessage, StateMessage, WelcomeMessage } from './protocol';
import { startRumbleServer, type RumbleServer } from './server';

let havok: HavokInstance;
beforeAll(async () => {
  havok = await loadHavokNode();
});

let server: RumbleServer | null = null;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await server?.close();
  server = null;
});

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  welcome: WelcomeMessage;
  send(m: unknown): void;
  sendRaw(raw: string): void;
  /** Resolves once the server has handled everything sent before it (a ping's pong comes back in order). */
  sync(): Promise<void>;
  states(): StateMessage[];
}

async function start(manual = true) {
  server = await startRumbleServer({ havok, port: 0, manual });
  return server;
}

function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages: ServerMessage[] = [];
    let pingId = 0;
    const waiting = new Map<number, () => void>();
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMessage;
      messages.push(m);
      if (m.t === 'pong') waiting.get(m.id)?.();
      if (m.t === 'welcome') {
        const client: Client = {
          ws,
          messages,
          welcome: m,
          send: (msg) => ws.send(JSON.stringify(msg)),
          sendRaw: (raw) => ws.send(raw),
          sync: () =>
            new Promise((done) => {
              const id = ++pingId;
              waiting.set(id, done);
              ws.send(JSON.stringify({ t: 'ping', id, ct: 0 }));
            }),
          states: () => messages.filter((x): x is StateMessage => x.t === 'state'),
        };
        clients.push(client);
        resolve(client);
      }
    });
    ws.on('error', reject);
  });
}

/** Occupy every slot left, so no bot moves anything in a test that wants a quiet arena. */
const fillSlots = async (port: number) => {
  while (Object.values(server!.host.state().control).includes('bot')) await connect(port);
};
const ticks = (n: number) => {
  for (let i = 0; i < n; i++) server!.host.tick();
};
const snap = (): MatchSnapshot => server!.host.latest;
const fighter = (id: string) => snap().fighters.find((f) => f.id === id)!;
const input = (seq: number, intent: Record<string, unknown>) => ({ t: 'input', seq, intent });
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('slots and bots', () => {
  it('each connection is told the player it controls: P1, P2, P3, P4 in turn; a fifth only watches', async () => {
    const s = await start();
    const got: (string | null)[] = [];
    for (let i = 0; i < 5; i++) got.push((await connect(s.port)).welcome.you);
    expect(got).toEqual(['P1', 'P2', 'P3', 'P4', null]);
    expect(clients[0].welcome).toMatchObject({ players: ['P1', 'P2', 'P3', 'P4'], tickHz: NET.tickHz, snapshotHz: NET.snapshotHz });
    expect(Object.values(s.host.state().control)).toEqual(['human', 'human', 'human', 'human']);
    // The watcher's input reaches no fighter.
    const watcher = clients[4];
    ticks(30);
    const before = snap().fighters.map((f) => f.position.x);
    watcher.send(input(1, { x: 1 }));
    await watcher.sync();
    ticks(60);
    snap().fighters.forEach((f, i) => expect(Math.abs(f.position.x - before[i])).toBeLessThan(0.01));
  });

  it('empty slots are bots; a disconnect hands the fighter back to its bot at once, and the next connection takes the free slot', async () => {
    const s = await start();
    const a = await connect(s.port);
    const b = await connect(s.port);
    expect(s.host.state().control).toEqual({ P1: 'human', P2: 'human', P3: 'bot', P4: 'bot' });
    // The bots drive P3 and P4 from the first steps; the idle people stand.
    ticks(90);
    expect(Math.hypot(fighter('P3').position.x - -2.2, fighter('P3').position.z - 2.2)).toBeGreaterThan(0.3);
    expect(Math.hypot(fighter('P2').position.x - 2.2, fighter('P2').position.z - -2.2)).toBeLessThan(0.05);
    b.ws.close();
    await waitFor(() => s.host.state().control.P2 === 'bot');
    const at = { ...fighter('P2').position };
    ticks(60);
    expect(Math.hypot(fighter('P2').position.x - at.x, fighter('P2').position.z - at.z)).toBeGreaterThan(0.3);
    // The match went on: nothing was reset.
    expect(snap().tick).toBeGreaterThanOrEqual(150);
    const c = await connect(s.port);
    expect(c.welcome.you).toBe('P2');
    expect(s.host.state().control.P2).toBe('human');
    expect(a.welcome.you).toBe('P1');
  });
});

describe('the trust boundary', () => {
  it('a connection\'s input drives only its own fighter', async () => {
    const s = await start();
    const a = await connect(s.port);
    const b = await connect(s.port);
    await fillSlots(s.port);
    ticks(30);
    const p2 = { ...fighter('P2').position };
    a.send(input(1, { x: 0, z: 1 }));
    await a.sync();
    ticks(60);
    expect(fighter('P1').position.z - -2.2).toBeGreaterThan(RUMBLE_BODY.walkSpeed * 0.7);
    expect(Math.hypot(fighter('P2').position.x - p2.x, fighter('P2').position.z - p2.z)).toBeLessThan(0.01);
    // Naming another player in the message changes nothing: the connection decides whose input it is.
    b.send({ t: 'input', seq: 1, player: 'P1', intent: { x: -1 } });
    a.send(input(2, { x: 0, z: 1 }));
    await b.sync();
    await a.sync();
    ticks(30);
    expect(fighter('P2').velocity.x).toBeLessThan(-0.5);
    expect(fighter('P1').velocity.z).toBeGreaterThan(0.5);
  });

  it('malformed, oversized and non-finite input never reaches the match; long directions are cut to unit length', async () => {
    const s = await start();
    const a = await connect(s.port);
    await fillSlots(s.port);
    ticks(30);
    for (const raw of ['garbage', '{"t":"input","seq":1,"intent":{"x":null}}', '{"t":"input","seq":2,"intent":{"x":1e400}}', '{"t":"input","seq":3,"intent":{"x":"1"}}', `{"t":"input","seq":4,"intent":{"x":1,"pad":"${'x'.repeat(600)}"}}`, '{"t":"input","seq":5.5,"intent":{"x":1}}']) a.sendRaw(raw);
    await a.sync();
    ticks(60);
    expect(Math.hypot(fighter('P1').velocity.x, fighter('P1').velocity.z)).toBeLessThan(0.01);
    expect(s.host.state().acks.P1).toBe(-1);
    a.send(input(6, { x: 300, z: 400, run: true }));
    await a.sync();
    ticks(90);
    const v = fighter('P1').velocity;
    expect(Math.hypot(v.x, v.z)).toBeLessThan(RUMBLE_BODY.runSpeed * 1.05);
    expect(snap().fighters.every((f) => Number.isFinite(f.position.x) && Number.isFinite(f.position.z))).toBe(true);
  });

  it('a stale or repeated sequence number is ignored', async () => {
    const s = await start();
    const a = await connect(s.port);
    await fillSlots(s.port);
    ticks(30);
    a.send(input(5, { x: 1 }));
    a.send(input(3, { x: -1 }));
    a.send(input(5, { x: -1 }));
    await a.sync();
    ticks(45);
    expect(fighter('P1').velocity.x).toBeGreaterThan(0.5);
    expect(s.host.state().acks.P1).toBe(5);
  });

  it('there is no message for any authority hook: debug placement, power, score and hits are not reachable', async () => {
    const s = await start();
    const a = await connect(s.port);
    ticks(30);
    const before = JSON.stringify(snap().fighters.map((f) => [f.position, f.powerLevel, f.score, f.hits]));
    for (const t of ['debugPlace', 'teleport', 'setPower', 'setScore', 'hit', 'restart', 'clearInput', 'tick']) a.send({ t, id: 'P1', at: { x: 5, z: 5 }, x: 5, z: 5, powerLevel: 6, score: 3 });
    await a.sync();
    expect(JSON.stringify(snap().fighters.map((f) => [f.position, f.powerLevel, f.score, f.hits]))).toBe(before);
    expect(snap().tick).toBe(30);
  });
});

describe('one-shot requests and acknowledgements', () => {
  it('a jump sent with one input survives the next input arriving before the step, and is taken once', async () => {
    const s = await start();
    const a = await connect(s.port);
    await fillSlots(s.port);
    ticks(30);
    a.send(input(1, { jump: true }));
    a.send(input(2, { jump: false, x: 0.1 }));
    a.send(input(3, {}));
    await a.sync();
    ticks(1);
    expect(fighter('P1').jumps).toBe(1);
    ticks(60);
    expect(fighter('P1').jumps).toBe(1);
  });

  it('so does a punch', async () => {
    const s = await start();
    const a = await connect(s.port);
    await fillSlots(s.port);
    ticks(30);
    a.send(input(1, { punch: true }));
    a.send(input(2, {}));
    await a.sync();
    ticks(1);
    expect(fighter('P1').combat.punchTime).toBeGreaterThanOrEqual(0);
  });

  it('so does a grab: the hold is the server\'s, on the fighter in front', async () => {
    const s = await start();
    const a = await connect(s.port);
    await connect(s.port);
    // Set the scene server-side (test setup, not a message): P1 facing P2 at grab range.
    s.host.match.debugPlace('P1', { x: 0, z: 0, yaw: Math.PI / 2 });
    s.host.match.debugPlace('P2', { x: 0.9, z: 0, yaw: -Math.PI / 2 });
    ticks(3);
    a.send(input(1, { grab: true }));
    a.send(input(2, {}));
    await a.sync();
    ticks(1);
    expect(fighter('P1').holding).toBe('P2');
    expect(fighter('P2').heldBy).toBe('P1');
  });

  it('a state says which input sequence the match had applied by its tick', async () => {
    const s = await start();
    const a = await connect(s.port);
    ticks(3);
    expect(s.host.state().acks.P1).toBe(-1);
    a.send(input(7, { x: 1 }));
    await a.sync();
    // Arrived, but not yet stepped: not yet acknowledged.
    expect(s.host.state().acks.P1).toBe(-1);
    ticks(1);
    expect(s.host.state().acks.P1).toBe(7);
    s.broadcast();
    await a.sync();
    const last = a.states().at(-1)!;
    expect(last.acks).toEqual({ P1: 7 });
    expect(last.control).toEqual({ P1: 'human', P2: 'bot', P3: 'bot', P4: 'bot' });
    expect(last.tick).toBe(4);
    expect(last.snapshot.tick).toBe(4);
  });
});

describe('time and disconnects', () => {
  it('the real clock runs the match at 60 Hz and sends states at about 20 Hz, ticks always increasing', async () => {
    const s = await start(false);
    const a = await connect(s.port);
    const t0 = snap().tick;
    await new Promise((r) => setTimeout(r, 1000));
    const ran = snap().tick - t0;
    expect(ran).toBeGreaterThan(54);
    expect(ran).toBeLessThan(66);
    const states = a.states();
    expect(states.length).toBeGreaterThan(16);
    expect(states.length).toBeLessThan(23);
    for (let i = 1; i < states.length; i++) expect(states[i].tick - states[i - 1].tick).toBe(NET.tickHz / NET.snapshotHz);
    expect(s.stats.dropped).toBe(0);
  });

  it('a person whose inputs stop arriving does not keep running; a disconnect drops held input at once', async () => {
    const s = await start();
    const a = await connect(s.port);
    await fillSlots(s.port);
    ticks(30);
    a.send(input(1, { x: 1 }));
    await a.sync();
    ticks(30);
    expect(fighter('P1').velocity.x).toBeGreaterThan(1);
    // Silence (a frozen tab): after the timeout the fighter is let go of and stops.
    ticks(Math.round(NET.inputTimeout * NET.tickHz) + 30);
    expect(Math.abs(fighter('P1').velocity.x)).toBeLessThan(0.05);
    // Holding a direction, then gone: the bot drives from the next step, nothing of the person's input left.
    a.send(input(2, { x: -1, punch: true }));
    await a.sync();
    a.ws.close();
    await waitFor(() => s.host.state().control.P1 === 'bot');
    expect(s.host.state().acks.P1).toBeUndefined();
    ticks(1);
    expect(fighter('P1').combat.punchTime).toBe(-1);
  });
});

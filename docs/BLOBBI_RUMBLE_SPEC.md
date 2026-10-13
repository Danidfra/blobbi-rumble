# Blobbi Rumble — Specification v1

**Status:** living specification · **Version:** v1 ·
**Implementation baseline:** `d28e60f` (M9C–M9F) plus the M10 batch ·
**Last major completed milestone:** M9A (validated for real). M9B (adult
Rumble forms) is implemented and partly validated for real (the look
changes, legacy forms, persistence, manual reconnect); its animation and
lifecycle checks are still open. M9B.1 (Nostr session restoration) is
implemented but not yet validated for real.

Read this first. It says what Blobbi Rumble is, what exists, which
boundaries are deliberate and which decisions are settled. It does not
describe every file. The details live in the code and in:

- [`README.md`](../README.md): running, gameplay mechanics in prose, a file map.
- [`HOSTING.md`](../HOSTING.md): operating a server (rooms, `PUBLIC_URL`, limits, invites).
- [`NOSTR_SOCIAL_ARCHITECTURE.md`](NOSTR_SOCIAL_ARCHITECTURE.md): the Nostr research (M8A0) and the "as built" notes for M8A, M8B, M8C-A, M8C-B, M8C-B.1, M8C-B.2, M8C-C (with the search research), M9A (with the Blobbi event model as found) and M9B (Blobbi identity ≠ Blobbi form).

> **When this specification conflicts with current verified
> implementation, investigate the discrepancy. Do not blindly change
> working code to match stale prose.** The repository is the source of
> truth for implementation details; this document is the source of truth
> for intent and invariants.

MUST / SHOULD / MUST NOT are used in their RFC 2119 sense.

---

## 1. Product vision

Blobbi Rumble is a physics party brawler starring Blobbis: up to four
round, soft creatures on a small floating arena, shoving, punching,
grabbing and throwing each other off the edge. Last Blobbi standing takes
the round; first to three takes the match.

The spirit:

- **Fast.** Rounds are short; the arena is small on purpose.
- **Physical.** Bodies push, tumble and fly; contact is felt.
- **Funny.** Wriggling, flailing, being carried off a cliff.
- **Readable.** You can see why something happened.
- **Predictable enough to play intentionally.** A punch does what it did
  last time; skill shows.
- **Not simulation-heavy realism.** Physics serves the fun. Where realism
  and readability disagree, readability wins.

Party brawlers with soft, floppy characters are the reference mood. They
are context, not something to clone.

---

## 2. Core design principles (invariants)

1. The **authoritative server MUST decide every gameplay outcome**:
   movement results, hits, holds, throws, pickups, hazards, eliminations,
   rounds, scores, the winner.
2. **Clients MUST send only intent** (a movement direction, run, and
   jump / punch / grab requests) plus pings. They MUST NOT send positions,
   hits, pickups or results, and the server MUST NOT accept them.
3. **The visual Blobbi follows its physics body and is never a source of
   truth.** Nothing visual feeds back into the simulation.
4. **Blobbi visual morphology MUST NOT change competitive colliders or
   stats.** Every fighter has the same normalized gameplay capsule, mass,
   reach and speeds (`profile.ts`, from the kit's
   `BLOBBI_GAMEPLAY_PROFILE`), whatever it looks like.
5. **Nostr is identity, social, discovery and invite infrastructure. It
   MUST NOT carry realtime gameplay or decide any gameplay fact.**
6. **Gameplay, physics and networking MUST stay outside
   `@blobbi-kit/3d`.** The kit gets only small, generic, reusable visual
   fixes.
7. **Reusable Blobbi visual representation belongs in the kit**, not in
   Rumble's gameplay code.
8. Gameplay SHOULD favour readable fun over physical realism (bounded
   velocity changes, clamped impacts, tumbles that are rotations rather
   than ragdolls).

---

## 3. Gameplay (current, accepted)

Players: **2 to 4 fighters per match**, always four in network rooms.
Empty slots are played by local test bots. In local mode, P1 and P2 share
one keyboard; P3 and P4 are bots (`?players=2|3|4`, `?bots=all`).

| Action | What it does |
| --- | --- |
| Move / run | A camera-relative direction; run is faster. Bounded acceleration and braking, applied as impulses on the Havok capsule. |
| Jump | From the ground only, with full control (not while stunned, tumbling or carrying); limited air control. |
| Punch | Hits ONE fighter: the nearest in the round within reach and arc (lower roster index on an exact tie). A cosmetic swing may start at once on the client; the hit is the server's. |
| Grab → carry → throw | Grab lifts ONE fighter to a hold point in front, which turns with the grabber at a bounded rate. Press grab again to throw. **No throw windup.** |
| Tumble / stun / recovery | A throw or a hard enough hit frees the victim's capsule to tumble (a real rotation, with little steering), then a short recovery rights it. A lighter hit is a brief stun. |
| Pushing | While capsules touch, steering becomes a bounded spring with a power-scaled push authority. Head-on keys push along the line between bodies; running adds nothing to a shove but impact. |

- **Impacts.** Every punch, throw and hazard goes through one path:
  base × power × attack × situation, clamped (`combat/impact.ts`).
- **Holds.** A held or holding body cannot be grabbed (at most one holder
  per body). A blow on either side, a tumbling carrier or a ring-out ends
  the hold.
- **Power orbs.** Three on the arena whatever the player count; scarcity
  is the point.
  - Walk into one to take it. It returns after 5 s where nobody stands.
  - Each orb is one power level, up to 6, and power resets every round.
  - Punch and throw impact: ×1.08 per level, up to ×1.48.
  - Push authority: +5% per level, up to ×1.30.
  - Walk and run speed: +1% per level, up to +6%.
  - Power changes nothing else: not jump, air control, reach, hold, mass
    or recovery.
- **Hazard.** The sweeper (§5).
- **Rounds.** A ring-out eliminates a fighter from the round.
  - The last Blobbi standing takes the point; the last fighters falling
    on the same frame is a draw (no point).
  - The next round starts after 1.6 s.
  - **First to 3 rounds wins the match.**
  - In network play, the next match starts by itself 5 s later. In local
    mode, R restarts after a match.
- **Bots** (`control/bot.ts`). Deliberately simple state machines (seek an
  orb, seek a fighter, attack, carry and throw, recover), driven by a
  seeded sequence rather than dice.
  - They avoid the rim, step round the sweeper post, jump the sweeper bar
    and struggle with a human rhythm (about 1.8 s).
  - They produce the same intents a keyboard does, so a bot's fighter has
    exactly a person's body.
  - Bots are test opponents, not an AI.

### 4. Grab struggle (accepted, frozen pending playtest evidence)

A held fighter breaks free by **reversing** its movement, left-right-left-
right. Only opposite directions count, so the camera never matters.

- Holding a direction, or repeating one, counts nothing.
- Useful input is capped at about 6.7 reversals a second.
- **6 counted reversals break the hold**: about **1.2 s** at a good human
  pace, 0.8 s at the cap.
- Then both sides are cleared, the freed body is pushed away, and it has
  **0.6 s of regrab immunity** (it can still be hit).
- The struggle is evaluated after the step's attacks, so a throw on the
  same step wins: a quick throw beats a struggle, a long carry does not.
- **There is no throw windup.**

Numbers live in `STRUGGLE` in `tuning.ts`. They are accepted as they are
until real playtests show otherwise.

### 5. Arenas

**Arena 1, Floating Islands Classic**, is deliberately **small, fast and
dangerous**, and is kept exactly as it was (M11A preserves it to the
metre: the same three slabs at one height, the same sweeper, orbs and
spawns, no ledges to catch, no pieces that move):
- a wide, safe centre slab (8 × 8 m) where everyone spawns;
- two narrower wings (3.5 × 6 m) closer to the rim;
- a void all round.

**The sweeper** sits in the right wing: a low bar (0.22 m) through a post,
turning at 1.5 rad/s with a 2 m reach, moved by Havok as an animated body.
- Only its leading face strikes, through the normal impact path: a shove
  near the post, a punch-like hit mid-bar, a tumble near the tip.
- It can be jumped with timing near the tip.
- Its blow sends you toward the centre on the inner half of its circle,
  toward the rim on the outer half.

**Orb placement** follows the zones: one contested in the centre, one
inside the sweeper's circle, one deep in the left wing near the rim.

**Visual identity:** a floating garden island in a bright sky (§6).

- Arena 1 **MUST NOT be resized** merely because a future mode might want
  more space. Its size is part of its pace.

**The other arenas (M11, implemented — awaiting manual validation)** are
definitions in the same registry (`src/rumble/arena/arenas.ts`), not a
second system: each is a list of platforms at their own heights, with
optional dynamic pieces, conveyors, a sweeper of its own, orbs, spawns, a
fall line, camera bounds, and whether its edges can be held (§15f).

| Arena | id | What makes it |
| --- | --- | --- |
| Floating Islands Classic | `floating-islands-classic` | The island above, unchanged. The default. |
| Floating Islands: Skyfall | `floating-islands-skyfall` | Islands at several heights joined by two rope bridges that break (three heavy blows on a body over one, or the round's clock at 28 / 34 s), two pads that fall under weight and come back, a low ledge under the centre's north wall, a step and a perch to the south. No sweeper. Edges can be held. Fall line −5. |
| Blobbi Factory | `blobbi-factory` | A plated floor with two conveyor belts running opposite ways, a crate in the middle (an orb on it), a rotating arm on the west pad (the sweeper's rules at its own pivot). Edges can be held. |
| Frozen Lake | `frozen-lake` | Nine ice tiles and two lobes: everything slides (low friction, weak steering, almost no braking), the four corner tiles crack under weight and fall, then freeze over again. Ice cannot be held. |

A room is made with an arena (`?arena=<id>`; unknown or absent: Classic)
and optionally rotates to another with each new match (`?rotate=1`); every
welcome names the room's arena, every state names the arena in play, and
nothing of the geometry rides a snapshot (§15f).

---

## 6. Visual architecture

```
@blobbi-kit/3d (published package)          Rumble (this repo)
  procedural 3D Blobbi from an identity  ◄──  view/: draws snapshots only
  animation, face, traits                     fighterView, arenaView, sweeperView, orbView,
                                              world (camera, lights, sky), theme, decor, camera
                                       ▲
physics body (Havok capsule) ──► position / velocity / grounded ──► visual Blobbi (follows, never feeds back)
```

- **`@blobbi-kit/3d`** owns the Blobbi's look: a procedural mesh from the
  V3 identity, its face, traits and animator. Rumble consumes the
  published package and contains no copy of the renderer.
- **Rumble's `view/`** draws the match from snapshots and owns the
  arena's look.
  - Visual Pass 1 made the arena a floating garden lawn: rim trim, soil
    and rock undersides, a candy-striped sweeper, a sky dome, clouds,
    distant islands, one shadow-casting sun.
  - Decoration is placed deterministically, clear of play.
  - Repeated meshes use merged meshes and thin instances.
- **Morphology independence.** The renderer never reads gameplay stats,
  and gameplay never derives a collider from a mesh (§2.4).
- Presentation MUST NOT touch the match: the presenter only reads
  snapshots and the differences between them.

---

## 7. Authoritative simulation

**`RumbleMatch`** (`sim/match.ts`) is the whole game with no renderer,
DOM, keyboard or clock:
- `createRumbleMatch({ havok, players })`
- `setInput(id, intent)`
- `step(dt)`, which returns the step's events
- `snapshot()`, plain data
- `restart()`

It owns its fighters' Havok bodies in its own physics world, on a Babylon
`NullEngine` scene that is never drawn. It decides movement, collisions,
targets, hits, holds, throws, pickups, sweeper hits, tumbles,
eliminations, rounds, scores and the winner.

- **60 Hz fixed step.** A fixed-step loop on the server's monotonic
  clock. If the loop falls behind it catches up by at most a few steps,
  then drops the backlog (counted); it never fast-forwards.
- **Headless.** The same match runs in plain Node (`npm run headless`) at
  about 400–500× real time; it is used for tests and measurements.
  Repeated runs of the same build reproduce identical results, which
  makes it a regression check. Network play does **not** rely on
  determinism: the server is authoritative, and there is no lockstep.
- **Input model.** `PlayerIntent` = a ground-plane direction (cut to unit
  length), run, and one-shot jump / punch / grab requests. One-shot
  requests wait in the match until a step takes them. L4.4A: a press the
  fighter cannot act on at that step waits a short window in the fighter
  (jump buffer and coyote time, a punch buffer before the cooldown ends, a
  grab window; `INPUT_WINDOWS`), at most one of each, never out of play.
- **The client MUST NOT authoritatively decide:** positions, collisions,
  hits or targets, holds or escapes, throws, pickups, power, hazard hits,
  eliminations, round or match results, slot assignment, or another
  player's identity.

---

## 8. Networking

```
browser (intent) ──WebSocket──► Node server ──► Room ──► RumbleHost ──► RumbleMatch @ 60 Hz
       ▲                                                                     │
       └──────────── state snapshots @ 20 Hz (+ acks, roster) ◄─────────────┘
```

- **Transport.** JSON over one WebSocket per client (`ws`).
  - The client sends `input` (numbered intents) and `ping`; for identity
    also `challenge`, `auth` and `logout`. L4.4A: at most one input every
    12 ms whatever the display rate, its direction quantized to 1/1000;
    each input carries `presses`, per action the count of presses since
    the connection opened, so an input lost to the rate limit loses no
    press (the server acts on a count that went up, once per message).
  - The server sends `welcome`, `state`, `pong`, `challenge`, `auth` and
    `roster`. The wire protocol is `net/protocol.ts`.
- **`RumbleHost`** (`net/host.ts`) owns one match and its four slots.
  - A connection takes the first free slot; a fifth watches.
  - A person who leaves hands the fighter straight back to its bot, and
    a silent client's held movement is released after 1 s.
  - The host acknowledges the highest input `seq` applied.
- **Snapshots** go out at 20 Hz. The state message carries no identity or
  profile data.
- **Local prediction** (`client/predict.ts`). Your own fighter is predicted
  from your keys with the server's steering, then reconciled on every
  state by replaying the inputs not yet acknowledged.
  - Errors under 5 cm are left alone; larger ones glide away; over 1.2 m
    they snap.
  - Nothing is predicted while the server has you (tumbling, held,
    stunned, out).
- **Remote interpolation** (`client/interp.ts`). Everything else is drawn
  100 ms behind the server, blended between states, with at most 50 ms
  of extrapolation.
- **Limits.**
  - Size and rate: 4 KB frames, 120 messages/s per connection (a
    sustained flood is disconnected), back-pressure on slow clients, a
    heartbeat.
  - Connections: 64 in all, 8 per room.
  - Identity: one auth challenge per second per connection.
  - The Origin header is logged, not enforced.
- **Validation status.** Real multi-machine LAN play and a real remote
  Internet player were tested (M7D). Players reported it fluid; normal
  play showed no meaningful lag.
- **Lag compensation (M7E) is not currently justified** by those tests.
  It is not ruled out, but adding it requires evidence: measured problems
  in real play.

---

## 9. Hosting model

One Node process serves the built game, the WebSocket (`/ws`),
`/.well-known/rumble.json` and `/healthz` on one port: `npm run serve`.
TLS is terminated in front of it (a tunnel, reverse proxy, platform or
VPS). An `https` page automatically uses `wss` on its own origin.

| Kind | Example |
| --- | --- |
| Official hosted | a Blobbi-run server on the built-in official list (`rumble.blobbi.pet`) |
| Community | someone's VPS or reverse proxy, possibly naming an operator |
| Player-hosted | `npm run serve` on a laptop, reached over a LAN, Cloudflare Tunnel, Tailscale Funnel, a reverse proxy or a VPS |

- **Player-hosted ≠ peer-to-peer.** A player-hosted server runs the same
  authoritative Node process; clients still send only intent to it.
- **Trust.**
  - **Casual** play: a participant-hosted server is acceptable (players
    knowingly trust the host).
  - **Future value-bearing** play (sats, prizes): requires a **neutral,
    trusted authoritative server**, not one run by a competitor. Rooms
    already record `mode: 'casual'` so the two cannot be confused later.
- **Why not WebRTC / P2P.** A browser-hosted authority adds TURN and
  signalling, dies with a hidden or closed tab, has no host migration,
  gives the host a 0 ms advantage, and can never be neutral for stakes.
  The authoritative host stays transport-free, so an experiment remains
  possible; it is not the architecture (M8A0 §13).

---

## 10. Rooms

One process hosts several rooms (`net/rooms.ts`). Each room owns exactly
one `RumbleHost`; nothing is shared but the process and the Havok wasm.

| | |
| --- | --- |
| **OPEN** | The open room. Always exists; a plain visit plays here; never reaped. |
| **Private rooms** | Created on request ("Host a game") with a fresh code. |
| **Codes** | 4 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O, 1/I/L), unique among the server's live rooms. Input is upper-cased, spaces and dashes dropped. `OPEN` contains an O, so no generated code can collide with it. |
| **Addressing** | Page `/play/CODE` (served by `npm run serve` and the Vite dev server). Socket `/ws` (open), `/ws?room=CODE`, `/ws?create=1`. |
| **Create / join** | Host and Join switch rooms in place (a new connection, the same page). After a create, the page's address becomes `/play/CODE`, so a **reload or reconnect rejoins** the room rather than creating another. |
| **Isolation** | Inputs, states, scores, rounds, bots, restarts, rosters and identities stay inside their room (tested). |
| **Lifecycle** | A private room lives while anyone is connected to it, then **120 s** after the last connection leaves; then its match is disposed. L4.5A: when every room is taken, the private room empty the longest (≥ 20 s) gives way to a new one; a private room with people but no activity a person makes (moving, a press, a lobby request, a look, someone arriving; a match on always counts) for 20 minutes is warned, then closed (`4009`). |
| **Storage** | In memory only. **A server restart ends every private room** (players see "Room … isn't here"). |
| **Limits** | 16 rooms (OPEN included), 8 connections per room (4 play, 4 watch), 64 in all, 5 new rooms per address per minute, 2 private rooms open per address (L4.5A; 1 once only 4 places are left). Refusal codes: `4004` no such room, `4003` no new room, `1013` full, `4009` closed for inactivity. |

> **A ROOM CODE IS NOT A SECRET.** Current private rooms are
> code-addressed rooms, not access-controlled or cryptographically private
> rooms. Anyone with the code or link can join.


### 10a. Lobby rooms and the match lifecycle (L1)

**Status: L1 (lifecycle core), L2 (room controls), L3 (lobby and results interface), L4 (the social lobby, Blobbi Plaza), L4.1 (plaza first: the menu and the public plaza) and L4.2 (the interface overhaul) implemented, awaiting manual validation.** Approved 2026-10-11 after
the lobby architecture audit. The **OPEN room keeps continuous drop-in
play**; private rooms made by current clients get a lobby.

A lobby is a **stage of an existing room**, not a new kind of object:
the same code, link, invites, grace period, limits, identity, looks and
`RumbleHost` / `RumbleMatch` (one Havok world per room, reused with
`restart()` and `switchArena()`). The lifecycle is pure state over the
room's tick (`net/lifecycle.ts`), applied by the host.

```
LOBBY ──start──► COUNTDOWN ──deadline──► PLAYING ──match won──► RESULTS ──deadline──► LOBBY
  ▲                 │ someone it started with left / below the minimum
  └── cancelled ────┘
```

| Stage | The match | Ends |
| --- | --- | --- |
| **lobby** | Stands still (`match.idle`: tick and clock advance, nothing moves, no input taken). Warm-up play is L4. | A start (L1: as soon as the minimum is met; L2: ready / owner). |
| **countdown** | Stands still; on its swap tick the match restarts on the room's arena, every fighter at its spawn. | Its deadline (play), or a cancel (back to the lobby). |
| **playing** | The match as ever (bots, rounds, scores). | The match is decided. |
| **results** | Settled, as a won match always was. Results: winner, reason, and per fighter who drove it at the end (bot, guest, proven pubkey) and its score. | Its deadline: the swap back (a rotating room moves to its next arena here, so the lobby shows it). |

Times (`LIFECYCLE`): departure 2.3 s and arrival 2.6 s (the countdown,
about 4.9 s), results 8 s. Nothing starts while the return to the lobby is
still arriving. Ticks never go back: states stay in order through every
swap.

**Transitions are facts with deadlines, not pictures.** Every change of
place is announced ahead as `{ kind: 'toArena' | 'toLobby', departAt,
swapAt, arriveBy }` in ticks. The server swaps on `swapAt`; clients draw
whatever they like over the window. This is where the teleport
(nostr-pet's `present → departing → absent → arriving → present`, whose
departure ~2.3 s and arrival ~2.6 s the times above follow) will plug in:
departure until the swap, the swap hidden while absent, arrival after.
A countdown cancelled before its swap has moved nothing, so a client can
turn the departure back. A fade is an acceptable placeholder, but nothing
may assume the transition is only a fade, and no gameplay fact depends on
what is drawn.

**Negotiated both ways** (the game is deployed; no client may misread a
room):

- A client that knows the lobby says `caps=lobby` in its socket URL; the
  server lists `lobby` in the welcome's `features`.
- `create=1&caps=lobby` makes a lobby room (`room.lifecycle: 'lobby'`; the
  listing gives its stage as `phase`). `create=1` without it still makes a
  continuous room, which such a client understands.
- A client without `caps=lobby` is refused a lobby room with close code
  **1008** and the reason `update required: reload the page to join this
  room`. Pre-lobby pages show that as a refusal without retrying; current
  pages say "This room needs a newer Blobbi Rumble".
- The wire `protocol` number is unchanged (1): bumping it would mark every
  deployed page incompatible with the OPEN room too.

The server sends each connection of a lobby room a `lobby` message on
every change (before the state of the tick it happened on): the stage, its
start and deadline ticks, the transition, the connection's own seat
(`you`, which may change between matches), the owner's seat and whether
this connection owns the room, the seated and ready seats, the lineup, the
settings, the minimum, and the last results.

#### Room controls and match management (L2)

**Status: L2 implemented.** The server decides all of it; a client only
requests (`ready`, `start`, `settings`) and is told `refused` with a
reason (`not-owner`, `spectator`, `phase`, `too-few`, `busy`, `malformed`,
`no-lobby`). Nothing a client says about ownership, seats or readiness is
read.

| Rule | |
| --- | --- |
| **Ready** | A seated person may be ready or not, in the lobby and the countdown. Bots are always ready. Back from the results, everyone is unready. |
| **Automatic start** | When every seated person is ready and the minimum is met. |
| **Owner's start** | The owner may start while some are not ready; never below the minimum, never during the return's arrival (`busy`). |
| **Minimum** | Bots on: one seated person (against bots). Bots off: two. |
| **Cancel** | Someone the countdown started with leaves; the room falls below the minimum; or (not for the owner's start) someone stops being ready. Back to the lobby; it starts again by itself if the rest are all ready. Nobody can hold a room in a countdown. |
| **Owner** | The room's first connection. When the owner leaves, the longest-present seated person takes over, else the longest-present watcher, else nobody (the next to arrive owns it). It belongs to the connection, like an identity. |
| **Settings** | The owner's, in the lobby only (refused in the countdown, play and results): `bots`, `arena` (switched at once, while the match stands still), `rotate`. Default bots on. A change applies to the next match; nothing can change a running one. |
| **Bots on** | Every seat is a fighter; bots drive the ones nobody holds (the existing bot filling). A person leaving mid-match is replaced by a bot, as before. Nobody left: the match is `abandoned`. |
| **Bots off** | The match is built at the countdown's swap with only the seated people's seats (a new `RumbleMatch` on the same arena, its tick and clock carried on, the old one disposed). An empty seat is `{ who: 'empty' }` in the roster, never a bot. A person leaving mid-match forfeits: their fighter is out of every round and driven by nobody; with one person left, they win by `forfeit`. |
| **Seats** | Given only in the lobby. Someone arriving during the countdown, the match or the results watches, and is seated when the room is back in its lobby; free seats go to watchers, longest-present first. |
| **Score ownership** | A fighter's score is its own. Nobody joins a lobby room's running match, so nobody inherits a score; results say who drove each fighter at the end. In the OPEN room, a drop-in player taking over a bot's fighter starts it at 0 (the only change to OPEN's behavior). |
| **Rate limits** | Per connection, one `ready` per 250 ms, one `start` per 1 s, one `settings` per 500 ms; more are refused as `busy` (and still count against the message bucket). |

#### The lobby and results interface (L3)

**Status: L3 implemented, awaiting manual validation.** Part of the game's
shell (`client/lobbyView.ts`: a pure model from the server's `lobby`
message and roster; `client/lobbyUi.ts`: the DOM), not a separate app.

| | |
| --- | --- |
| **Lobby card** | Right side, under the top bar. Room code, Copy link, Invite… and Choose Blobbi… (both open the session panel, where invitations, the Blobbi picker and identity already live: nothing duplicated). Every seat with its 2D Blobbi preview (the fighter's Rumble look: a worn form or the seat's default), name, tags (you, owner ★, the Blobbi it wears) and a pill: Ready, Not ready, Bot, Open. Who waits for the next match. The settings: bots and rotation switches and the arena grid for the owner; read-only text for everyone else. The status, Ready / Not ready and the owner's Start pinned at the card's foot. It folds to its header. It steps aside for the session panel, help, settings, the start card and the banner. |
| **Countdown** | A big centred number (pointer-events off). Settings and Start disappear; Not ready stays for everyone's countdown (it cancels it) and is hidden in the owner's (it would not). A cancel redraws the lobby from the server's message. |
| **Results** | A centred card for the server's results time: the winner (or "Match abandoned"), every fighter by name with Human / Bot / Left and its score, the reason, the seconds back. Then the lobby, with "Last match: … won". No match starts by itself: everyone is unready after the results. |
| **Watching** | A chip "Waiting for next match"; the session chip, status line and reconnect note say "waiting for next match" in a lobby room (OPEN keeps "watching (all four slots taken)"). Watchers are listed in the lobby card and seated by the L2 rules. |
| **Empty seats** | `control: 'none'` in the state, `{ who: 'empty' }` in the roster and the results, "Open seat" / "Open" in the lobby, "Left the match" / "Left" in the results: never a bot. |
| **Lineup on screen** | In the lobby the server rebuilds the standing-still match to the next lineup whenever it can be a match (two or more fighters), so no fighter of the last match stays; the page also draws only the lineup's fighters before a match (`visibleLineup`), which covers one person alone without bots. |
| **Phones** | Safe-area insets; under 520 px of height a 300 px / 44 vw card, a smaller countdown, a compact share row; 40 px touch targets; the actions pinned in reach without scrolling. The touch controls hide outside play in a lobby room (nothing moves there). |
| **Keys** | R toggles Ready (shown in the button on a desktop); H, Esc, F3, F4 as before. Buttons never take focus. |

A lobby room's creation no longer opens the session panel (the card has
the code, link and invitations); an older continuous room's still does.

#### The interface overhaul (L4.2)

**Status: L4.2 implemented, awaiting manual validation.** The page's
interface redrawn around where the player is and what they do, with the
3D world as the main attraction; no gameplay, lifecycle or protocol
change. It replaces the L3 lobby card, the L4.1 plaza card and the session
panel described above (their functions are all kept).

| | |
| --- | --- |
| **Contexts** | `client/hud.ts` reads the page into one of: menu, public plaza, private room between matches (lobby, countdown, results), combat (a private room's match, Quick Match), away (connecting, lost, refused). Each shows only what it needs. |
| **Top bar** | Left: the **place pill** (🌸 Blobbi Plaza 3/8; 🔑 A7F2 2/4 · 1/2 ready; ⚡ Quick Match), then in a room between matches the **room bar**: Ready / Not ready (the main action, R on a keyboard), the owner's Start, ✉ Invite. Middle: the scoreboard, in a match only. Right: **you** (your fighter's picture, your name, invitations waiting) and ⚙. |
| **Sheets** | One expandable panel at a time, closed by ✕, Escape, a press outside it, or going somewhere else. The **place sheet** (the pill): the plaza's menu (Quick Match, Create room, Join room; public rooms and hosting options folded; Main menu), or a room's tabs Players / Settings (the owner's; others read them) / Invite (code, Copy code, Copy link, the Nostr invitations) / Leave, or Quick Match's Players / Leave. The **profile sheet**: name (never a key), the Blobbi worn, Nostr, the Blobbi picker, the invite inbox. The **settings sheet**: graphics, FPS counter, camera (touch), full screen, How to play, the server and game servers. One of each feature: the invite sender, Blobbi picker and server list exist once. |
| **Menu** | The game's front door: three Blobbis and the name, Enter Plaza (primary), Quick Match, Create room, Join room (an inline code field), who you play as and Connect Nostr. Side by side on a phone on its side, stacked on a narrow upright screen. Still connects to nothing until a choice; direct links unchanged. |
| **Results** | The winner's Blobbi and "… wins!", every fighter with its picture, Human / Bot / Left and its rounds as dots, "Back to the plaza in N s" with a bar. Timing and scoring are the server's, unchanged. |
| **Connection words** | Where a connection is headed (Heading to Blobbi Plaza…, Finding a Quick Match…, Joining room A7F2…), never the server's address; plain titles and an icon for every refusal; every refusal offers ⌂ Main menu. "A bot plays your Blobbi" only where the room hands a held seat to a bot (Quick Match, a private room with bots on); never on the plaza, with bots off, or for a watcher (`onClose`'s `takeover`, decided by the page from the room's rules; the server is unchanged). |
| **Look** | `client/uiTheme.ts`: tokens (ink, pastels, radii, soft shadows, rounded type), buttons (plain, main, soft, warn, on, icon), frosted chips over the world, pills, tabs, two-way switches, sections. Dark ink on pale fills (no white text on pastel). Motion only for presses, the spinner and the rotate hint, none with reduced motion. |
| **Phones** | Landscape first (checked at 844×390, 812×375, 667×375): one slim top row clear of the stick (lower left 48 % × 72 %) and the buttons (lower right); sheets fit the height and scroll inside; 38–40 px targets; the touch controls step aside while a sheet, the results, the menu or the banner is up. |
| **Input** | A click never leaves a button focused (Space and Enter stay jump); Tab reaches every control, with a visible focus ring; while a field or a list has the keyboard the game takes no key, and (L4.4A) while a button or a folding heading has it only Space and Enter are the control's, every other game key still plays (`control/input.ts` `interfaceKeeps`, `isUiKey`). Escape lets a field go, else closes the help or the sheet, else lets go of a focused control. A sheet used from the keyboard gives the focus back to its button; one closed with a pointer gives the keyboard back to the game (L4.4A, `focusAfterClose`). The page uses no history entries for sheets, so Back still leaves the page as before. |
| **Room for L5** | A sheet tab (chat), the free lower middle (an emote bar or picker on a phone, clear of the stick and buttons), and the roster rows (inspecting a Blobbi) are the intended places; nothing of L5 is built. |

#### Frame stalls from the face (L4.6-FIX1)

**Status: L4.6-FIX1 implemented; measured in local headless Chrome on a
desktop; awaiting manual validation.**

| | |
| --- | --- |
| **Cause** | Every blink and every expression change, the kit re-lays each eye, lid, brow and mouth disc (`@blobbi-kit/3d` `face.apply` → `layDisc`), one exact skin lookup per vertex (`surface.frontPoint`, outline scans): 15–30 ms per Blobbi. Blinks of several Blobbis land in one frame: with eight in the plaza, frames of 100–320 ms (37 over 100 ms in 15 s). Not the network, not the GPU (rendering under 1 % of the profile). |
| **Fix** | Each fighter's face lookups go through a bounded lattice of exact skin samples, 2 root units apart, bilinearly interpolated (`view/surfaceCache.ts`; ≤ 0.05 mm, ≤ 0.3°, ~9k nodes, ~17× cheaper), warmed for the blink when the fighter is built (~26 ms once). Same faces, same quality, same blinks and expressions. With eight Blobbis: p99 4.3 ms, worst 9.1 ms, none over 33 ms. |
| **FPS counter** | It showed Babylon's `getFps()`, which is only measured under `runRenderLoop`; the page runs its own loop, so it always read 60. Now `client/frameMeter.ts` measures the frames actually shown over the last second, and the worst frame ("fps · worst ms"); a stall shows. |

#### Security and privacy hardening (L4.5B)

**Status: L4.5B implemented; checked with automated tests and a local
headless-browser run against a recording fake server; awaiting manual
validation.**

| | |
| --- | --- |
| **Server trust for identity** | A Nostr proof goes by itself only to a trusted server: official, this site's own, the dev server, or an exact WebSocket URL the player approved (`servers.ts` `identityTrusted`, at most 16 kept, re-checked from storage). Elsewhere a remembered login is held (no extension call) and Connect asks first (`identity.ts`, phase `confirm`); only a yes approves that exact address. |
| **Profiles** | Other players' profiles only from the fixed lookup relays; only the player's own on its own relays (`directory.ts` `ownRelaysFor`). Pictures of others only in views the player opens (invites). |
| **Proxy and connections** | `CLIENT_IP_HEADER` must be one real IP and can be limited to `TRUSTED_PROXIES` (`address.ts`); near full, 4 connections per network instead of 8. `PUBLIC_URL` is required in production (cross-server relay of proofs; tested both ways). |

#### Graphics and GPU cost (L4.4B)

**Status: L4.4B implemented; measured in local headless Chrome (desktop
and phone-sized emulation on a desktop GPU); no real device yet.**

| | |
| --- | --- |
| **Shadows** | A Blobbi's face (eyes, lids, brows, mouth: 21 of its ~30 meshes) no longer casts a shadow; the body, arms, feet, ears, horns, tufts, antennae and tail still do (`view/fighterView.ts` `shadowCastersOf`; the kit is asked for no casters). In a scene where Blobbi shadows show clearly (mid-jump, seen from the shadow's side, close up), removing the face casters changed no pixel; with eight Blobbis the shadow casters go from 263 to 95 and the draw calls from 315 to 243. |
| **Skin** | Each Blobbi's painted skin is 1024 × 512 (`SKIN_WIDTH`), not the kit's 2048 × 1024: a close-up on a desktop and on a 3× phone was indistinguishable (512 visibly softened the blush and freckles). Per Blobbi about 2.7 MB of GPU texture instead of 10.7 (estimated) and a quarter of the canvas memory and repaint. Every Blobbi keeps its own skin and materials. |
| **Unchanged** | The shadow map, the quality levels (Auto / Low / Medium / High with the frame budget), the lighting, the arenas, the physics and the network. |

#### Combat input reliability (L4.4A)

**Status: L4.4A implemented; browser-validated locally (desktop and
phone-sized emulation); awaiting manual gameplay validation and a real
device.** The L4.3 audit's lost-input findings, fixed without making the
client authoritative.

| | |
| --- | --- |
| **High refresh rates** | The page sent one input per rendered frame while moving (the camera's yaw carries float noise, so every frame looked changed) and the server keeps 120 a second: at 144–240 Hz inputs, presses and all, were dropped. Now `client/inputPacer.ts` quantizes the direction, sends at most one input every 12 ms, latches presses until sent, and counts them; the server's `PressCounter` acts on a count that went up. The rate limit is unchanged. |
| **Keyboard focus** | Closing a sheet left its button focused and every game key dead. A focused control now keeps only Space / Enter (and arrows for arrow widgets); a sheet closed with a pointer releases the focus; a keyboard user is returned to the button. |
| **Windows** | `INPUT_WINDOWS` (`tuning.ts`): jump buffer 100 ms (6 steps), coyote time 83 ms (5 steps, only after leaving the ground without a jump), a 150 ms lockout after a jump (one press is one jump), punch buffer 100 ms before the cooldown ends (at most one, earlier presses refused), grab window 100 ms (reach and arc unchanged). The jump gate (`control/mover.ts` `gateJump`) is shared by the server's fighter and the client's prediction. A grab pressed with a punch in the same step is judged first; a grab press used to let go of a ledge, or mashed while held, grabs nothing. |

#### Plaza first: the menu and the public plaza (L4.1)

**Status: L4.1 implemented, awaiting manual validation.** A plain visit
no longer drops anyone into combat: it shows a **menu** and connects to
nothing until the player chooses.

| | |
| --- | --- |
| **Menu** | **Enter Plaza** (primary), **Quick Match** (the OPEN room, as before), Create room, Join room (code); who you play as. Direct links still connect at once: `/play/CODE`, `?room=OPEN`, `?room=PLAZA`. Quick Match and the plaza keep their names in the page address, so a reload goes back there. |
| **Public plaza** | One permanent room, `PLAZA` (an L: never a generated code), on every server, never reaped. Its host's `plaza` mode is only the social plaza: the L4 `SocialSpace`, movement, physics, camera, touch controls and Blobbi looks, with no lifecycle, match, ready, owner, bots in seats, scoring or combat. Guests and proven Nostr identities alike. |
| **Capacity** | **8 people**, one avatar per connection (no watchers there); the 9th is refused with 1013 "plaza full": the page says "Blobbi Plaza is full." and offers Try again, Create private room and Quick Match, never retrying by itself and never sending anyone into a match. One plaza per server for now. Measured server cost: 0.05 ms per tick at 8 avatars; ~5.2 KB per state, ~102 KB/s per client, ~0.8 MB/s for a full plaza. |
| **Ambient bots** | `B1`, `B2` (never a seat's id): 2 for 0–1 people, 1 for 2, none from 3. No connection, identity, roster entry or capacity; they stroll (`control/wander.ts`), never fight. A change settles 2 s (no flicker on a reload); a bot appears on a far corner, and the one that goes is the one furthest from anyone. Tagged "Bot". |
| **Plaza card** | Who you are (a display name, never a key), the Blobbi worn (Choose… opens the session panel's picker), Create room, Join room, Quick Match, Menu; "Everyone here sees your name and your Blobbi." Folded on touch (Quick Match kept in the header). No ready, start, owner, bots or rotation. |
| **Negotiation** | `caps=plaza` (pages now say `caps=lobby,plaza`); a client without it is refused the plaza (1008, update required) and never sees it in the listing. |
| **Switching** | All in one page, one socket at a time (`switchTo`); Menu closes the connection (its seat freed at once). Identity is proven again and the chosen Blobbi declared again on each new connection. Late messages of an old socket are ignored. |

The plaza takes one of the server's 16 rooms (OPEN, PLAZA and up to 14
private rooms).

#### The social lobby: Blobbi Plaza (L4)

**Status: L4 implemented, awaiting manual validation.** A lobby room's
lobby is no longer an overlay on a standing-still arena: it is its own
small, walkable 3D space, Blobbi Plaza.

**One space at a time per room** (`RumbleHost`): the plaza
(`sim/social.ts`, `SocialSpace`) in the lobby and the countdown until its
swap; the match (`RumbleMatch`) from the countdown's swap tick to the end
of the results; at each swap the old physics world is disposed and the new
space carries the tick and clock on. A countdown cancelled after its swap
returns to a new plaza at once (L6 may announce that return too). The
OPEN room is untouched.

| | |
| --- | --- |
| **Space** | `arena/lobbySpace.ts`: the plaza as data in an arena's shape (`blobbi-plaza`, theme `social`), never in `ARENAS`: never chosen, rotated to or listed. One flat 13 × 10 m floor inside a fence of four walls (`kind: 'wall'`, 1.6 m, frictionless) higher than any jump; the decoration stands outside the fence, in the view only. |
| **Movement** | Each avatar is a `FighterSim` stepped as the match steps locomotion (`update`, `settle`, `turn`, fall line): the same walk, run, turn and jump. Punch, grab and throw requests are dropped on arrival; no pushing contest (bodies only bump); no score, elimination, rounds, orbs or hazards. Below the fall line an avatar returns to its seat's spot after 0.8 s. |
| **Avatars** | The lineup: seated people, and every other seat when bots are on. Watchers keep watching (no avatar; the design leaves room for walking watchers later). Avatars are added and removed without rebuilding anything. |
| **Bots** | `control/wander.ts`: a deterministic stroll (seeded per seat): walk to a spot inside the fence, idle, walk again; never run, jump or fight; stop short of people and step away from anyone closer than 0.9 m. Bots are always ready. |
| **Sync** | No new message: the same input intents and 20 Hz states over the room's socket. The state names the plaza as its arena; the page predicts on the plaza's floor and fence (`PLAZA_TERRAIN`), so walking into the fence is not pulled back. |
| **Camera** | On the plaza, a third-person follow of the page's own Blobbi (`view/camera.ts`, `followPose`): 6.2 m behind, the look point kept inside the fence, the angle the player's (mouse orbit; on touch, a finger drag, and Recenter puts it behind the Blobbi), never lower than 1.12 rad from overhead so it passes over the hedge, lanterns and arch. A watcher gets the shared overview; arenas keep the combat camera. |
| **View** | `view/socialView.ts`: cream and peach tiles, a lilac gathering circle, a flower hedge, lanterns, mushrooms, benches, an inert portal arch (L6's place) and a sign naming the next match's arena. Static pieces merged per material; only Blobbis cast shadows. |
| **UI** | The L3 card, folded by default on touch (its header keeps "n/m ready", Ready and the owner's Start); the owner's star and a ready tick in the name tags; touch shows the joystick and Jump only (no combat buttons), and the camera drag and Recenter. |

**Resources.** Every swap disposes the old space's physics world (tested
over repeated cycles), and on the page the old view: a browser run over
three match cycles held the scene at the same counts each time (plaza: 80
meshes, 55 materials, 8 textures; arena: 139, 90, 17). Finding that
required fixing two older leaks that every match now reaches: an arena
view left its decoration's and hazards' materials and every texture, and a
fighter view its two ring materials. The interpolation buffer starts over
on a change of space or lineup, so nothing is blended across a swap.

**Reconnection is not seat recovery.** A dropped connection is a new
connection: it gets a seat only by the L2 rules (a free seat in the
lobby), never "its" seat back. A pubkey alone is not proof that a new
connection is the old one: a later mechanism may use an authenticated
Nostr proof on the new connection or a short-lived server-issued token.
Nothing of the kind exists yet, and no new authentication protocol was
added.

---

## 11. Server identity and trust

All of these are optional (`net/serverIdentity.ts`, `net/serverTrust.ts`):

- **`PUBLIC_URL`**: the server's **one canonical origin** (e.g.
  `https://rumble.example`).
  - It is the single source for: the address identity proofs must name
    (`wss://…/ws`), share links (`…/play/CODE`) and the well-known
    document.
  - Extra comma-separated addresses are accepted in proofs only.
  - Unset (LAN, dev): proofs bind to the Host header of each connection
    (weaker, documented), and pages share their own origin.
  - Forwarded headers are **not** trusted.
  - A malformed value stops the server at start.
- **`SERVER_NAME`**: a display name.
- **`OPERATOR_PUBKEY`**: npub or hex, **as claimed**.
- **`/.well-known/rumble.json`**: versioned and readable from any origin.
  `{ protocol, version: 1, websocket, capabilities }`, plus `name`,
  `operator` and `url` only when configured.

**Labels** the page shows:

| Label | Means |
| --- | --- |
| Local server | localhost, a private or link-local address, a tailnet, `*.local` |
| Official server | on the built-in list **and** over TLS; the only check is the TLS certificate |
| Community server | names an operator, as claimed |
| Unknown server | anything else |

Operator and community claims are **not** cryptographically verified.
Every server, whatever its label, is the authority over its own matches.

---

## 12. Nostr architecture

```
Nostr:   identity · profiles · social · invites · (later, maybe) discovery
         └── never: gameplay transport · physics · authoritative state · realtime simulation
```

- **Library:** `nostr-tools` only.
- **Code layout:**
  - generic Nostr code is `src/social/`, which imports only nostr-tools
    and itself (test-enforced), so it can become a shared package later;
  - Rumble glue is in `src/rumble/client/` (`identity.ts`, `invites.ts`,
    `inviteSender.ts`, `shell.ts`) and the server handshake in
    `net/server.ts`.
- **Relays:**
  - lookups go to `purplepag.es`, `relay.damus.io`, `relay.ditto.pub`,
    plus at most 3 of a user's own relays;
  - suggested NIP-17 inbox relays for setup: `auth.nostr1.com`,
    `relay.nostr.net`, `nos.lol` (§15);
  - at most about 8 open lookup connections, idle ones closed;
  - a page with only guests opens no relay connection.
- The user's identity private key **never** reaches Rumble.

### 13. Nostr identity (M8A)

- **Guest** is fully supported and is the default. Nostr is optional.
- **NIP-07 only.** The extension is asked only after a click.
  - Every signer call has a timeout and a classified error (unavailable,
    denied, timeout, malformed, failed).
  - Whatever the extension returns is checked: a well-formed pubkey; an
    event that verifies, is by that key and is exactly the template.
- **Profiles.** Kind 0 is looked up by clients, never by the server.
  - Text is cleaned and bounded, and rendered only as text.
  - Pictures must be `https`; otherwise a deterministic identicon is shown.
  - Profiles are cached in memory and localStorage with age limits. No
    profile means a short npub.
- **Remembered identity** is `{ v, method, pubkey, auto }`. It is a hint
  and proves nothing; "Reconnect Nostr" asks the extension again.
- **Session restoration (M9B.1, implemented).** `auto` is set by an
  explicit connection and only then. On page load, with `auto`, the page
  asks the same kind of signer for its public key (nothing is signed for
  this; the extension may prompt once) and:
  - the remembered pubkey → the normal connected state (`restoring` →
    `proving`), the same code path as a click, so the game proof, the
    Blobbi choice, the inbox and its automatic-checking consent follow as
    for a click;
  - another pubkey → `changed`: shown with "Connect as …" / "Not now" /
    "Forget"; nothing switches by itself and the remembered identity's
    Blobbi choice and invites are not applied;
  - no extension → `known` with Reconnect, `auto` kept (no prompt
    involved, so the next visit may try again);
  - a refusal or a time-out → `known` with Reconnect, `auto` off: no
    prompt repeats by itself.
  - Once per page; a click or Disconnect during it wins (a generation
    guard discards the late answer). **Disconnect Nostr** removes the
    record, so a reload stays a guest.
  - **It always settles** (hotfix): finding the extension and asking its
    public key are each bounded by the restore's own wait (15 s, not the
    60 s a click allows for a prompt). The end states are: connected
    (`proving`, then `verified` once the game answers; a game server that
    is down leaves `proving`, never a false `verified`), `known` with
    Reconnect (no extension, with `auto` kept; a refusal or a time-out,
    with `auto` off), or `changed`. While restoring, the chip offers
    Connect Nostr to take over.
  - What is stored: the pubkey, the method and `auto`. Never a key, a
    token, a challenge, a signature or a message.
  - Restoration grants nothing: the game proof is a fresh challenge on
    every connection as before, and decrypting is the extension's
    permission plus the identity's own M8C-B.2 consent.
- **Proof flow.**
  1. The server sends a one-use challenge (32 random bytes, 2 min,
     bounded).
  2. The client signs a **kind 22242** with `relay` = the game WebSocket
     URL and `challenge`.
  3. The server verifies it locally (signature, challenge, its own
     address, ±5 min clock skew).
  4. The connection's slot shows the pubkey in the roster.
  - Identity belongs to the **connection**, never to the slot, and is
    never restored on reconnect.
  - Duplicate pubkeys on two connections are two separate players.

> **INVARIANT: the game-auth kind 22242 is transmitted directly over the
> Rumble WebSocket and MUST NOT be published to Nostr relays.**
> Test-pinned: the identity module imports no relay, pool or inbox code.

- **Validated** with a real NIP-07 extension (the player resolved as
  `danidfra`; disconnecting returned to Guest without interrupting play).
- **NIP-46** (remote signers) is future work and does not block rooms or
  invites.

### 14. Private Nostr invites — sending (M8C-A, implemented)

```
Alice (in a private room, Nostr-connected, extension with NIP-44)
  kind 14 rumor   unsigned, by Alice: readable text + tags
  kind 13 seal    extension NIP-44-encrypts the rumor to Bob; extension signs; tags []
  kind 1059 wrap  NIP-44 from a one-time key to Bob; tags [p Bob, expiration]
  ──► Bob's kind-10050 inbox relays (at most 3, wss only)
```

- **Capability.** NIP-44 is optional and feature-detected. Without it,
  identity, rooms and play are unaffected; only sending is unavailable,
  and **Copy link** remains.
- **Recipient.** An `npub` or `nprofile` (a `nostr:` prefix is accepted).
  nprofile relay hints only help *find* the inbox list.
- **Inbox.** The recipient's kind 10050 list, located via the lookup
  relays, hints, then NIP-65 write relays.
  - The wrap goes **only** to the list's own `relay` tags, which must
    literally be `wss://`, at most 3.
  - **No 10050: nothing is sent**, and the panel offers Copy link.
- **Message.** A normal kind 14:
  - content `"<name> invited you to Blobbi Rumble: <room link>"`;
  - tags `["p", recipient]`, `["r", <room link>]`,
    **`["b", "blobbi:rumble:invite:v1"]`**,
    `["expiration", now + 30 min]`.
  - The link is the canonical M8B share link (`/play/CODE`, from
    `PUBLIC_URL` when set), and the text and the `r` tag carry the same
    link.
  - No sender field (the seal proves the sender), no sender self-copy.
- **Timestamps.** The seal and the wrap are backdated randomly by up to 2
  days. The wrap's expiration is the rumor's plus random slack. The seal
  carries no tags: NIP-59 requires that, and it overrides NIP-17's
  suggestion to put an expiration there.
- **Success** means at least 1 inbox relay accepted ("Invite sent (k of n
  inbox relays)"); total failure is reported as failure.
- **Wrapper key.** A one-time NIP-59 wrapper key is generated in memory
  for each wrap and dropped. This is protocol machinery, not an identity
  key: *Blobbi Rumble never generates, stores or handles the user's Nostr
  identity private key.*
- **Publishing boundary.**
  - `social/inbox.ts` is the app's only publisher. It has exactly two
    publishing entry points, each validating before the single private
    publish call:
    - a valid kind 1059, only to an inbox set built from a kind 10050
      list (used by the invite sender);
    - since M8C-B.1, the player's **own** kind 10050 list, only to
      discovery and inbox relays, only after an explicit confirm (used
      by inbox setup).
  - Events are verified on a fresh copy (`social/verify.ts`), so a
    modified copy can't inherit a cached "verified" result.

**Two kind-22242 uses that MUST NOT cross:**

| | GAME AUTH | RELAY AUTH |
| --- | --- | --- |
| Challenge from | the Rumble server | a Nostr inbox relay |
| `relay` tag | the game WebSocket URL | that inbox relay's URL |
| Sent to | the game WebSocket only | that relay's connection only |
| Signed by | `client/identity.ts` | `inboxRelayAuth`, which signs only an exact NIP-42 template naming one of that inbox's relays |

- **Validated for real:**
  - Blobbi Rumble → a real NIP-17 inbox relay → Anagram, which decrypted
    it and showed a normal, readable kind 14 DM with the correct sender,
    recipient, `/play/CODE` link, marker, expiration and text;
  - a recipient without a 10050 list got the "no private-message inbox"
    fallback, and nothing was sent;
  - the LAN-only link warning appeared.

### 15. Private invite receiving (M8C-B, validated), inbox setup (M8C-B.1, validated) and automatic checking (M8C-B.2, validated)

**Receiving (M8C-B).**
- **Opt-in.** Nothing is decrypted until the player clicks **Check
  invites**; the privacy explanation sits beside the button.
- **Where.** The player's own kind 10050 inbox (`wss://`, at most 3) is
  read. Only kind 1059 addressed to them, within a recent window (wraps
  are backdated up to 2 days).
- **How many.** At most **30** wraps are decrypted in the first check,
  newest first, then up to 30 more live while the page stays open. Each
  wrap costs 2 NIP-44 decrypt calls on the extension, on this device
  only. Nothing goes to the Rumble server.
- **Unwrapping** applies every NIP-17/NIP-59 check:
  - wrap: verified, kind 1059, addressed to me;
  - seal: verified, kind 13, no tags;
  - rumor: unsigned, id = hash, author = the seal's signer.
- **Recognition.** Only `["b","blobbi:rumble:invite:v1"]` makes an
  invite, and it needs:
  - `p` = me and exactly one `r` link to a canonical `/play/CODE` (`https`
    unless the host is local);
  - message text naming that same single link;
  - not expired (lifetime capped at 35 min) and not dated more than
    10 min ahead.
- **Unrelated messages** are dropped where they were opened: never shown,
  stored, logged or kept in state.
  - De-duplicated by wrap id and rumor id.
  - sessionStorage keeps only the ids of wraps already judged, per
    identity, so a reload doesn't decrypt them again.
- **The card** shows the sender (from the seal; the profile name is
  cosmetic), room, destination host, trust label (from the host name only:
  nothing is fetched from the destination before joining) and time left.
  - **Join** is explicit: it switches room on the same server, or opens
    the other server's `/play/CODE` page. Never `?server=`.
  - Dismiss is local to the session.
- **Identity changes.** Disconnect or another identity stops everything
  and forgets all invite state.

**Why unrelated wraps must be decrypted:** NIP-17 deliberately hides the
inner message's kind and tags, so a Rumble invite cannot be told apart
from any other private message before decryption. Hence the opt-in and
the budget.

**Inbox setup (M8C-B.1).**
- **Discovery.** On connecting Nostr, Rumble looks up the player's kind
  10050 list (public data; nothing is decrypted).
- **An existing valid list is used exactly as it is:** never overwritten,
  merged with defaults or republished. Editing relays is out of scope.
- **With no list,** the Invites section offers **Set up private
  invites**:
  - suggested inbox relays (`auth.nostr1.com`, `relay.nostr.net`,
    `nos.lol`), probed read-only with nothing signed, which the player can
    untick;
  - a plain note that publishing makes them the player's public
    private-message relay list;
  - only an explicit **Publish and set up** proceeds.
- **On confirm,** Rumble:
  1. checks again, strictly, that no list exists. Enough lookup relays
     must answer (fewer means "uncertain", and nothing is signed), and the
     NIP-65 write relays are asked too;
  2. has the extension sign the kind 10050 (`["relay", url]` tags, empty
     content);
  3. publishes it to the lookup relays, the player's NIP-65 write relays
     (at most 3) and the chosen inbox relays, with relay AUTH for exactly
     those;
  4. reads it back from the lookup relays.
- **Results:**
  - **done**: discoverable and every chosen inbox accepted;
  - **partial**: discoverable and some accepted;
  - **unverified**: published but not readable back yet;
  - **failed**: nothing usable.
  - It never re-signs or retries by itself.

**Automatic checking (M8C-B.2).**
- **Consent first.** Once an identity is connected with NIP-44 and a
  located kind 10050, Rumble asks once: "Automatically check for Rumble
  invites?", with "Rumble checks a small number of recent encrypted Nostr
  messages and listens for new ones while you're connected. Other messages
  are discarded immediately." and **Enable automatic invites** / **Not
  now**. A small corner card, and the same question in **Invites**.
  Nothing is decrypted before Enable.
- **Scope.** One preference per Nostr identity and per browser origin
  (localStorage, `on` or `off`; never a message). "Not now" is `off`: the
  question is not repeated; **Automatic invites: Off · Turn on** stays in
  the panel.
- **Start.** With it on, the same check as the button starts by itself
  when the identity connects (and when a list is adopted after setup):
  the same 30-wrap catch-up, newest first, remembered ids skipped; then
  the same live subscription. The panel says **Listening for private
  invites**; a new invite goes to the Invites section, the ✉ badge and
  the toast. No gameplay interruption.
- **Pause.** If the extension refuses or does not answer a decrypt
  request, checking pauses: "Automatic invites paused — decrypt permission
  needed", with **Try again**. Nothing is asked again by itself (not by a
  new list, not by a reconnect); a reload tries once. The preference is
  not changed by a pause.
- **Off.** Turning it off closes the subscription at once, keeps what was
  shown, leaves **Check invites**, and never touches the kind 10050.
- **Lifecycle.** A game-socket reconnect or a room switch does not restart
  the inbox (the same signer); an identity change or Disconnect Nostr
  stops it and clears all invite state; stale asynchronous work is cut off
  (a run that awaited across a stop goes no further).
- **Automatic checking is permission to check, not to join.** Join stays a
  click; nothing navigates by itself.

**Not implemented:** editing an existing inbox list, invite replies, chat.

### 15a. Choosing whom to invite (M8C-C, validated)

- **One box** in Invite a friend: "Search name, npub or NIP-05".
  - npub / nprofile: one exact person, selected at once (hints are where
    to look, never an inbox).
  - `name@domain` or a bare domain: resolved by that domain (NIP-05: no
    redirects, 3 s, bounded, hex only), selected at once.
  - a name (2–64 characters): matched among the player's follows and
    cached profiles first, then on **two** search relays (NIP-50,
    `relay.vertexlab.io` and `relay.ditto.pub`, chosen by live probing)
    after a 300 ms pause; every relay answer is re-matched locally;
    results are merged, ranked (exact, prefix, contains, NIP-05; people
    you follow first) and capped at 10; stale answers are dropped.
- **People you follow:** the player's own kind 3, **read only**, most
  recently followed first, 8 at a time with Show more (at most 40);
  profiles are looked up only for the rows on screen; no inbox lookups
  for lists of people.
- **Rows** show avatar, name, a short npub (names are never unique), a
  NIP-05 only once its domain confirmed it, and "Following" where it
  applies. Text only; nothing from a profile is rendered as HTML.
- **Selection is explicit** and changeable; **Send invite** is a separate
  click; the chosen person goes through the M8C-A sender unchanged, which
  looks up their kind 10050 then and reports "no private-message inbox"
  as before.
- **Limits, stated in the panel:** Nostr has no global name index; name
  search can miss people and include impostors; an npub or NIP-05 is the
  reliable path.
- **Not changed:** the invite message, the send path, the game server; no
  new event kinds; nothing published (not the follow list, not an inbox
  list).

### 15b. The player's Blobbis (M9A, validated)

- **The model is the ecosystem's** (`@blobbi-kit/core` 0.9.0): a Blobbi
  is one kind 31124 at the owner's address (`d` =
  `blobbi-<owner prefix>-<pet id>`), every stage a replacement at the same
  address, newest wins; the owner is the author. Kind 11125 (profile,
  `has`, `current_companion`), 31125 (deprecated profile) and 1124
  (interactions) are never Blobbis and are not read. No new kinds.
- **Discovery** is read only: kind 31124 by the verified identity with the
  ecosystem marker from the Blobbi relay (`relay.ditto.pub`), at most 200,
  through the bounded pool; every event signature-checked again; only
  what the kit calls modern (legacy is hidden, never migrated); newest per
  address. Nothing is signed, published, hatched, evolved or changed.
- **Every generation is listed** (V1, V2 authored artwork; V3 procedural,
  the only one Rumble's 3D fighter can be built from); an unknown
  `visual_generation` is shown but cannot be chosen.
- **The choice is local**: one `d` in this browser's storage under the
  identity's pubkey; **Use the default fighter** is the only thing that
  removes it; a new identity never sees another's. No event is published
  to remember it.
- **Discovery failure is not absence** (hotfix). A query reports which
  relays sent their complete answer. Unanswered (down, timed out, still
  sending): nothing is concluded, what was known stays, the choice stays,
  one automatic retry, then Try again. Answered without the chosen Blobbi:
  the choice is kept and said to be unloadable right now (a bounded query
  on one relay proves no deletion); the default fighter plays meanwhile
  and the form returns by itself when the Blobbi is listed again, the same
  form, with no new selection.
- **Nothing in play changes**: the collider, mass, speeds, jump, punch,
  grab and every gameplay number are untouched; the choice is not sent to
  other players (M9C). Guests and players with no Blobbis play exactly as
  before; nothing blocks a match.
- **Previews** are the kit's own 2D drawing as an image, never page markup.

### 15c. Adult Rumble forms (M9B, implemented)

**Blobbi identity ≠ Blobbi form.** A Blobbi is a formless creature: its
identity (kind 31124 at its owner's address) persists; in Rumble it
temporarily takes the form every fighter has here, an adult procedural
Blobbi. Not an evolution, a migration or an upgrade: the Blobbi's event,
stage, generation and 2D look are unchanged, and nothing is published.

- **One rule, deterministic**: a V3 adult is its own identity; a V3 egg or
  baby takes the adult body of the same identity; a V1 / V2 Blobbi takes
  the V3 identity of its own address, through the kit's own seed rule
  (`deriveBlobbiV3Seed(owner, d)`), wearing its own colours; an unknown
  generation has no form. The address is the only input: no RNG, clock or
  event id, so the same Blobbi is the same form on every device and after
  every rename, care, hatch or evolution (a pinned vector is tested).
- **Legacy colours are preserved** through the kit's stated-colour
  support; invalid colours fall back to the kit's palette.
- **The local fighter wears it**: the player's slot swaps its body (the
  old one disposed) when the choice, the slot or the identity changes; the
  default comes back on "Use the default fighter", Disconnect Nostr or an
  identity switch; a remembered choice is worn after a reload. The kit's
  one animator drives every form, so a legacy form moves, faces, punches,
  grabs and tumbles exactly like a native one.
- **Physics untouched**: every fighter has the same `RUMBLE_BODY`; a form
  carries no gameplay number and the form module imports none of the
  simulation. The server is unchanged.
- **Only this page sees it** until M9C.

### 15d. Everyone sees every fighter's form (M9C–M9F, implemented)

- **Protocol.** One small client message, `{ t: 'look', form | null }`,
  declares the form the sender's own fighter wears: `{ v: 1, d, gen,
  colors?, name? }`, bounded (a 32-character name, hex colours only on
  V1 / V2, exactly those fields). The server answers `{ t: 'look', ok,
  reason? }`. The roster, already sent to everyone on any change (never
  per frame), carries per slot `form: { v, d, gen, seed, colors?, name?
  }`. States carry nothing of it. The welcome lists the feature `looks`.
- **Server-controlled association.** A look binds to the connection that
  sent it and to the slot that connection holds; no field can name a slot
  or a pubkey (a declaration with one is not a declaration). It needs a
  proven identity on that connection, and the Blobbi address must be that
  identity's own (`d` = `blobbi-<its 12 hex>-…`); the **seed is derived by
  the server** from `(pubkey, d)` with the kit's rule and never taken from
  the client. A spectator wears nothing. A look goes with its identity
  (logout, another pubkey) and with its connection; the next holder of a
  slot starts with the default. The same look again changes nothing.
- **Trust boundary.** Verified: the sender's identity (a fresh signed
  challenge), and that the form names a Blobbi address owned by that
  identity (the ecosystem's rule: the author of a kind 31124 is its
  owner). Declared, not verified: that a kind 31124 exists at that
  address, its stage, its name, and (V1 / V2) that the colours are the
  Blobbi's own. Those are cosmetic and only ever change the declarer's
  own fighter's paint; the server consults no relay for them.
- **Every client draws the same looks** from the roster: the form is
  re-checked as untrusted data (version, seed shape, colours), then the
  same deterministic kit build as the owner's page (the same key). A
  server without `looks` shows a page its own form only. Guests and
  spectators are unaffected and see the same forms.
- **Lifecycle.** The page declares its form once proven, again on a new
  connection (room switch, reconnect, server restart) and whenever the
  chosen Blobbi, the default or the identity changes; the server's roster
  is the truth for every slot, so leaving, disconnecting, logging out and
  switching rooms clear looks everywhere without a second system. A failed
  discovery keeps the saved choice (§15b); when it resolves, the form is
  declared and worn by itself.
- **Identity presentation (M9D).** The name tag shows the person's name
  and, when their fighter wears a form, the Blobbi's name; the players
  list shows the person (name, avatar) and "<Blobbi> (Rumble form)" kept
  apart; guests are "Guest" with their slot label and the default
  fighter; spectators get the same list. Profile text is text only.
- **Physics untouched**: a look never reaches the match, and no gameplay
  number or collider depends on it (tested on the host's state).

### 15e. Online play: servers, public rooms, links, deployment (M10, implemented)

- **Servers (M10A).** A page knows official servers (build-time
  `VITE_RUMBLE_SERVERS`, none by default), its own origin at `/ws` (or the
  dev server), and community servers the player adds (localStorage, at
  most 12, checked on the way back); a link's `?server=` applies to that
  page only. Addresses are `ws(s)://` only, no credentials or fragments;
  an https page uses only `wss://`, never downgraded; plain `ws://` is for
  local addresses, and anywhere only in development. Nothing connects to a
  server from untrusted metadata.
- **Compatibility.** The welcome carries `protocol: 1` and `features`. A
  newer protocol is `incompatible` (no play, no retry); a pre-M10 server
  (no number) plays with fewer features; an origin refusal (4005) is
  `rejected`. A socket opening is never called compatibility.
- **Public rooms (M10B).** A room is listed or unlisted; the open room is
  always listed. `{ t: 'rooms' }` returns at most 32 rooms with counts and
  state only (never who), at most every 2 s per connection; the page asks
  while the panel is open, every 10 s. Request / response over the
  existing socket was chosen over a subscription: the list changes slowly,
  the page is already connected, and nothing is pushed to pages that are
  not looking. The listing is the room manager's memory; no database.
- **Hosting (M10C).** Host a public game (listed) or a private game
  (unlisted, by code or link only). A code is an address, not a secret:
  this is privacy from browsing, not access control (§16). Links are
  `/play/CODE` on the server's `PUBLIC_URL`; a page served elsewhere adds
  `?server=`, checked on arrival. NIP-17 invites are unchanged.
- **Deployment (M10D).** A Dockerfile and compose file run the one
  process (page and match) behind a TLS-terminating proxy; `/healthz`;
  SIGTERM shutdown; `ALLOWED_ORIGINS` enforces browser origins; the
  existing payload, rate, room and heartbeat limits stay. `npm run bench`
  measures rooms × ticks; capacity is what it says on the machine, not a
  promise.
- **Online UX (M10E).** Connection states: connecting, playing / watching,
  lost (reconnecting with back-off), unable to connect, full,
  incompatible, refused; latency from the existing ping. The game
  connection, the Nostr identity and the relays are three systems; a guest
  plays with no relay at all. A reconnect is a new connection: no session
  recovery is promised (§15e limitations).
- **Not done:** session recovery, server-side proof of a Blobbi's
  existence, access control, browser-hosted servers (nothing here
  precludes an authoritative host elsewhere later).

### 15f. Arena chaos, vertical survival and the eliminated (M11, IMPLEMENTED — AWAITING MANUAL VALIDATION)

- **Registry, selection, rotation (M11A).** `ArenaDef` is the one shape
  every arena has; the match builds its colliders from it
  (`sim/arenaBody.ts`), the view its lawn, plates or ice (`view/arenaView.ts`,
  themes `garden` / `factory` / `frozen`), the bots their picture of the
  floor (`control/bot.ts`), and the debug overlay its boxes. The host plays
  the arena its room was made with, rotates to another at each new match
  when asked (`nextArena`, never the same twice running, the random number
  injectable), and tells every connection — players, late joiners,
  spectators — `arena: { id, rotate }` in the welcome; the public listing
  names each room's arena; links carry `arena` and `rotate`; the panel
  offers both when hosting and shows them in the room. Local and headless
  play take `?arena=` / `ARENA=` (`ROTATE=1` headless).
- **Protocol.** One field in the welcome and the listing; in each state:
  `arena` (an id), `pieces` (phase, seconds, drop per dynamic piece),
  `roundTime`, `bananas`, and per fighter `ledge` and `bananas`. No
  platform geometry is ever sent: a client's registry has it by id. One
  new client message, `{ t: 'throw', x, z }`. A state message grew from
  about 2.6 KB to about 2.9 KB.
- **Dynamic pieces (M11B).** `arena/pieces.ts`: stable → warning → falling
  → gone (→ stable after `back` seconds, or never). A falling pad is armed
  by seconds of weight (draining while empty); a breakable bridge by heavy
  blows (tumble reactions) on bodies over it or by the round's clock. The
  collider is an animated Havok body that goes down with the piece and
  stops colliding when gone (`filterCollideMask = 0`), so a fighter on it
  falls through where the floor was; a round reset puts every piece back.
  The view shakes a warning piece, drops it, and hides it; ice cracks.
- **Ledges (M11C).** On arenas whose edges can be held, a fighter falling
  past an edge (airborne, falling faster than 0.5 m/s, free, upright, not
  tumbling, not just off a ledge) catches it within its hands' reach
  (0.75 m sideways, the top up to 1.3 m above the feet) and hangs below
  the top, facing in, weightless, sprung to its anchor. **Controls:** jump
  climbs (0.45 s, ends standing a step in from the edge); grab, or the
  stick held away from the wall for 0.35 s, lets go (the push that walked
  off the edge is over before that); nothing else moves a hanger. **Grip
  endurance** lasts 3.5 s hanging and returns on the floor (about 2 s to
  full); below 15 % no catch. A blow from above knocks the hanger off; a
  ledge on a piece that falls is lost with it; a hanger cannot punch, grab
  or be grabbed. **Elimination** is each arena's own fall line (`fallY`),
  not the classic −4 m: Skyfall's is −5, so its low ledge and its hangers
  are in play. **One pair of hands:** the hold is a single state on the
  fighter (`sim/ledge.ts`); two independent hands (one on a ledge, one on
  a fighter; hand-over-hand along an edge) would need a hand model through
  grabs, carries and struggles, which is out of scope and documented as
  such; the state is shaped so a second hold could sit beside it. Prediction
  hands a hanging fighter to the server; interpolation takes the hold from
  the newer state; the Blobbi hangs with its arms up, sags and kicks as it
  tires, and pulls itself over the top.
- **Factory (M11D).** Conveyors are bounded per-step velocity nudges
  toward the belt's speed on a fighter standing on one (never a launch),
  and the fighter's steering is relative to the belt, so standing still
  rides along and walking against it is slower; the arm is the sweeper's
  own state machine with the factory's pivot, reach and speed.
- **Frozen lake (M11E).** Ice tiles give the body a lower friction
  (0.06) and the steering less grip (acceleration × 0.3, braking × 0.03):
  a fighter slides on past where it stopped pushing, and turns slowly.
  The fragile corner tiles are the falling-piece system with a return.
  Nothing of the physics is changed globally; a fighter off the ice has
  its usual friction back the next step.
- **Banana peels (M11F).** A player out of the round may throw up to three
  peels a round, one every 2.5 s, onto solid floor (never a fallen piece),
  with at most four on the arena at once, each lying 12 s; never while
  fewer than three fighters are still in the round, so an out player never
  decides a duel. The server judges every throw and refuses silently
  (`pickups/bananas.ts`: `phase`, `in play`, `few alive`, `cooldown`,
  `spent`, `crowded`, `off floor`, `bad target`). A fighter running over a
  peel (feet within 0.45 m, moving at 0.6 m/s or more, on its feet, free)
  tumbles along its way through the ordinary strike path; the peel is
  gone. New rounds clear peels and budgets. Out at a keyboard, the
  movement keys aim a reticle over the floor and punch or grab throws; the
  HUD says what is left. Bots do not throw.
- **Bots on the new arenas.** A bot's "middle" is its own platform's; it
  never walks down a drop it could not come back from (> 0.7 m); going
  nowhere at a step up it jumps, at a rim it gives the target up; it runs
  and jumps a short gap (≤ 2.6 m) to a platform it can land on; hanging, it
  climbs at once. Bot-only matches finish on all four arenas headless.
- **Performance.** `npm run bench` (16 rooms, 10 s, 4 players): before
  M11 (`8b1ef14`) 0.42 ms per tick for all rooms; after, 0.42 ms on
  Classic, 0.44–0.45 ms on the other three (pieces, belts, ledges); state
  messages 2.6 → 2.9 KB. Headless: about 0.03–0.05 ms per tick, 350–560×
  real time.
- **Not changed:** M10's hosting configuration, the classic island's
  numbers, combat's grab / carry / throw / punch / tumble rules.
- **To validate by hand:** the arena choice and rotation from the panel in
  a real room with a late joiner and a spectator; bridges breaking and
  pads falling under real players; catching, climbing, tiring and being
  knocked off a ledge; the belts and the arm; the slide and the cracking
  ice; aiming and throwing peels while out, and slipping on one; the
  camera on each arena; frame times with the new views.

### 15g. Gameplay polish and balance (M11.1, IMPLEMENTED — AWAITING MANUAL GAMEPLAY VALIDATION)

The first manual playtest of M11 found Skyfall's bridges meeting their
islands at different heights (and a deck poking into an island's
underside), ledges catching unreliably around the bridges, the new arenas
small and dull, and the grab one-sided. M11.1 is the pass over those,
with no new mechanics.

- **Root causes.** (1) A carrier could RUN with its load (2.7 m/s) and a
  throw off a run travelled 4.6 m, so a grab anywhere on an 8 m slab was
  a ring-out before the 1.2 s a good struggle takes; the struggle's inputs
  themselves registered (0.9 s at the cap, 1.2 s at five strokes a second,
  2.0 s at three), but in network play the only hint was in the text HUD,
  which is hidden. (2) Skyfall's bridges were at the centre's height while
  their islands were half a metre up or down, so each bridge end met a
  wall or a drop, and the lower deck ran into the island's underside.
  (3) A half-metre step down counted as a fall to catch, so stepping off a
  bridge onto a lower island "caught" the edge. (4) Platforms were sized
  for walking, not for a carry-and-throw exchange.
- **Geometry (Skyfall).** One height for the centre, the bridges and the
  islands: centre 12 × 9 m (was 10 × 8), islands 5 × 5 and 5 × 4.6 m (were
  4 × 4 and 4.4 × 3.6) over 2 × 2 m bridges (were 1.6 × 1.7 and 2.2 × 1.7),
  the north ledge 6 × 1.6 m at −1.2 along the centre's wall, the south step
  (3.2 × 2, +0.5) and perch (3.6 × 1.8, +1.0), the falling pads 2.8 × 2.4 at
  the north-east and south-west corners. Every bridge end is flush with a
  platform of its height inside that platform's edge; nothing overlaps a
  bridge; the collider boxes and the drawn decks share the same tops.
  Useful fighting area at one height: about 108 m² of centre plus 48 m² of
  islands (was 80 + 32 at three heights).
- **Geometry (Factory).** Floor 12 × 8 m (was 9.5 × 7.2) with the belts
  along its north and south edges (1.6 m lanes) feeding 3.6 × 8 m pads
  (were 3 × 4.4 and 3.5 × 4.4) flush with the floor, the crate 3.2 × 2 m,
  the arm in the middle of the west pad (reach 1.7 m, 1.6 rad/s) with the
  pad's corners out of its reach. Fighting area about 96 + 58 m² (was 68 + 29).
- **Geometry (Frozen Lake).** Nine 3.6 m tiles (were 2.9 m): a 10.8 m
  sheet (was 8.7) with two 2.8 × 5.2 m lobes; the four corner tiles fragile
  with 1.8 s of weight to arm and 1.8 s of warning (were 1.4 / 1.4). The
  slide: from a walk 0.63 m, from a run 1.96 m, a 90° turn in 0.12 / 0.23 s.
- **Spawns** are at least two metres from any rim and from each other, on
  solid floor, never on a piece that can fall (the classic island's
  three-player spawn stays 1.55 m from its rim, as designed).
- **Grab, struggle, throw.** A carrier walks at 0.75 of walk speed and
  never runs (1.2 m/s), slower still as its load struggles (up to half);
  a hold ends by itself after 2.5 s (was 4); the throw's gain is 1.0 (was
  1.3): a standing carrier's throw lands 1.3 m away, a walking one's about
  2 m (was 2.7, and 4.6 off a run); a freed fighter cannot be grabbed for
  1.2 s (was 0.6) and a thrown one for 1.6 s (it lands, rights itself and
  has a moment; before, at once). The struggle itself is unchanged (six
  reversals, capped at 6.7 a second). Grabbed in the middle of the classic
  centre by a carrier walking for the rim, a fighter at five strokes a
  second is free in 1.2 s, 1.5 m short of the rim; at three a second,
  within the hold's longest time. The classic island's layout is unchanged;
  these rules make it fairer without touching it.
- **Feedback.** A cue under the action in every mode (local and network,
  whatever the text HUD): grabbed (by whom, the keys, the progress bar),
  holding (the throw key and the load's progress), hanging (grip and keys),
  out of the round (the aim).
- **Ledges.** A ledge must be at least 0.55 m above the feet (a step down
  is not a fall); the hands reach 0.5 m beyond the capsule (was 0.35; 0.75 since M12.1, §15i); a
  hang that would sit inside a neighbouring slab (an edge behind a wall) is
  no ledge; for 0.3 s after a climb the keys do not move the fighter, so a
  stick still pushed off the edge does not walk it straight back off (a
  later fall is caught again, never rung out); a ledge on a fallen piece
  stays invalid. Still one hold, one pair of hands (§15f).
- **Bots** cross the flat bridges on foot, leap a broken bridge's 2 m gap
  (the reach is 2.8 m), and finish matches on all four arenas headless.
- **Tests added.** Bridge endpoint alignment and overlap rules, spawn
  safety, fighting-area minimums, walkable transitions on foot (Skyfall's
  bridges both ways, the factory's belt onto a pad), the carrier's walk,
  the struggle's drag, the hold's end, the escape under normal conditions,
  immunities after an escape and a throw, the struggle through the host's
  numbered input path, no catch on a step down, no re-fall after a climb,
  hangs clear of neighbouring slabs.
- **Performance.** 16 rooms: 0.46 ms per tick (Classic) and 0.47 ms
  (Skyfall), states 2.9–3.0 KB: within noise of M11.
- **Known limitations.** One hold at a time (no independent hands, by
  design); bots do not throw peels; the struggle is still a keyboard
  rhythm (a gamepad stick works the same way through movement); the
  perch and step are reached by a jump, deliberately; the lake's slide is
  tuned by numbers, not yet by hands.

### 15h. Mobile support, touch controls and responsive play (M12, IMPLEMENTED — AWAITING REAL DEVICE VALIDATION)

Phones join the same rooms as desktops and play the same fighter through
the same intent. Nothing in the match, the server or the protocol changed:
a touch page sends the `input` and `throw` messages a keyboard page sends,
and the server validates them the same way.

**Audit (what existed before M12).** The canvas already had
`touch-action: none`; the viewport meta had no `viewport-fit`; the page
was sized with `100vh` (taller than the visible page on phone browsers);
the HUD had one breakpoint (`max-width: 860px`) that wrapped the
scoreboard into a second row; the orbit camera kept Babylon's pointer
input, so a finger on the arena turned the view (and with it the meaning
of "forward"); the engine drew at the full device pixel ratio (3× on many
phones) with a 2048 PCF shadow map; there was no post-processing and no
particle system. Input was keyboard only (`control/input.ts`), already
reduced to one transport-neutral intent; the struggle was already counted
from movement alone in any frame (`combat/struggle.ts`); NIP-07 was the
only signer.

**Controls** (`control/stick.ts`, `control/touch.ts`, `client/touchControls.ts`).

- *The stick* (left thumb, lower-left 48 % × 72 % of the screen) FLOATS:
  it appears where the thumb lands and its base trails a thumb that
  overshoots the rim. Chosen over a fixed stick because phones differ in
  size and grip and a thumb that lands off a fixed stick starts with an
  unwanted direction; a floating one cannot be missed. Its resting place is
  drawn faintly. Numbers: dead zone 18 % of the radius; then a walk from
  35 % to 100 % of walking speed (linear, `curve` adjustable); at 90 % of
  the radius and beyond, a run (the rim is the touch Shift). Directions
  are rounded to 128 around the circle and strength to 0.05, so a still
  thumb repeats the same numbers and the page sends no more messages than
  a keyboard does. Full deflection equals a key: a unit direction, never
  longer (tested).
- *The buttons* (right thumb): Punch (big), Jump and Grab around it,
  68–96 px from the screen's short side, inside the safe area. They fire on
  touch-down, once per press (no auto-repeat, as keys), show the press at
  once, and change their words with the moment (§ table). Grab and throw
  are one button, as G is one key.
- *Fingers* are tracked by pointer id and captured: the stick and any
  number of buttons at once. A finger lets go on lift, cancel or lost
  capture; the whole pad lets go on blur, a hidden page, an orientation
  change, and whenever the controls hide.
- *When shown*: a coarse primary pointer (`(pointer: coarse)`), `?touch=1`,
  or the first touch on the page (`?touch=0` never). Hidden (and
  released) while the session panel, the help, the start card, the banner
  or the rotate hint is up, for spectators, and before a slot is held. In
  touch play the orbit camera's pointer input is detached.

| Moment (`touchContext`) | Punch slot | Jump slot | Grab slot |
| --- | --- | --- | --- |
| fighting | Punch | Jump | Grab |
| holding someone | Punch | (dimmed) | **Throw** (the grab action) |
| held | **Break free** (a struggle stroke) | (dimmed) | (dimmed) |
| hanging on a ledge | (dimmed) | **Climb** (the jump action) | **Let go** (the grab action) |
| out of the round | **Throw** a peel, with "🍌 ×n", the cooldown, "none left" or "not now" | hidden | hidden |
| between rounds / no fighter | dimmed | dimmed | dimmed |

**Grab escape by touch.** Each tap of Break free is one stroke: the
movement goes to one side for 0.09 s (several server ticks), the next tap
to the other side. The server counts it exactly as it counts a keyboard's
alternation: 6 counted reversals, at most one per 0.15 s (plus 1.5 of
slack credit). Tests drive both through `stepStruggle` and through the
host: tapping at 4–6 a second progresses as alternating keys at the same
pace, and 20–30 taps a second is never faster than the cap. Wiggling the
stick left–right counts too (it is the same movement). The cue and the
pulsing button say what to do; the progress bar is the server's.

**Ledges by touch.** Climb is the jump; Let go is the grab; holding the
stick away from the wall for `LEDGE.awayHold` also lets go, exactly as the
keys do. Pushing toward the wall keeps hanging (tested through `tickLedge`).

**Banana peels by touch.** Out of the round the stick moves the reticle
over the floor at most `BANANAS.aimSpeed` (the keys' speed; tested), and
Throw asks for a throw only when the server's last word says one could go.
The rule is shared with the keyboard (`control/aim.ts`); the server judges
every throw as before.

**Layout** (`client/shell.ts`, `rumble.html`). `viewport-fit=cover` and
`env(safe-area-inset-*)` on every corner element (notches, rounded corners,
the home indicator); the canvas is `position: fixed; inset: 0` and cards
use `100dvh`, so nothing sits behind a phone browser's bars;
`interactive-widget=resizes-content` so the on-screen keyboard resizes the
page instead of covering fields. On a short screen (`max-height: 520px`, a
phone on its side) the top bar is one slim row (the scoreboard packs into
it), cards fit the height and scroll on their own (`overscroll-behavior:
contain`, `touch-action: pan-y`), the cue under the action shrinks. On a
small phone on its side (also `max-width: 760px`) the chips keep only the
room and the Nostr button. Under a coarse pointer, buttons are taller and
fields are 16 px (no iOS zoom on focus); the room-code field asks for
capitals, no autocorrect and a Go key. In touch play the help chip moves
to the top right ("? Help"), toasts and the invite question move to the
top, the duplicate struggle box hides (the cue shows it), the help card
lists the touch controls, and nothing on the game selects text or opens
the long-press menu. Desktop is unchanged: no touch UI, the same chips,
the keyboard words.

**Orientation and camera.** Landscape is the intended orientation.
Babylon fixes the vertical angle, so a wide landscape phone (about 2.2:1)
only sees more to the sides; the shared camera's framing, bounds and
per-arena drop lines are unchanged. A touch phone held upright (short
side under 600 px) gets a friendly "Rotate your phone" overlay over the
running match ("Play in portrait anyway" dismisses it for the visit); the
connection is untouched and nothing forces orientation. Upright anyway,
the view keeps the arena's width (`view/camera.ts fovFor`: below a 1.25
aspect the horizontal angle is fixed at what 1.25 shows). Orientation
changes resize the engine and release every finger; the match goes on.
*Full screen*: optional, from the session panel (Graphics), only where
the Fullscreen API exists (Android Chrome and most desktop browsers; not
iPhone Safari), only on that click; no orientation lock is requested.

**Graphics quality** (`view/quality.ts`, `presenter.setQuality`). The
renderer's real costs are the pixels drawn and the one shadow map, so a
profile changes only those; meshes, materials, colours, the Blobbi
appearance, shadows themselves and all gameplay feedback are the same at
every level.

| Level | Pixel ratio cap (M12.1) | Shadow map | PCF |
| --- | --- | --- | --- |
| High | 3 (the screen's own; 2 on a 2× screen) | 2048 | medium |
| Medium | 2 | 1024 | low |
| Low | 1 (budget may go to 0.75) | 512 | low |
| Auto, phone | 2, stepping down to 1 when slow | 1024 | low |
| Auto, desktop | 2 (what desktops always drew) | 2048 | medium |

(M12 had High 2, Medium 1.5 and a phone's Auto at Medium's 1.5: half a
3× iPhone's resolution each way, the playtest's "less sharp than
desktop"; see §15i.)

*Auto* (the default) starts from standard hints only (a coarse primary
pointer → the phone row; ≤ 2 cores or ≤ 2 GB `deviceMemory` → Low; else
the desktop row; never the user agent) and then follows measured frame times: a 2 s window
averaging slower than 1/40 s lowers the pixel ratio by 0.25 (down to the
profile's floor); three windows faster than 1/55 s raise it back (up to
the cap). The choice is saved per device (`rumble:graphics`) and shown
live in the panel (level, drawn size, ratio, shadow, fps). Desktop at
Auto is High: on a 2× screen it draws exactly what it drew before.
*Measured* (2026-10-10, this development Mac's GPU, `rumble.measureRender(120)`
— GPU-synchronised `scene.render()` at an 844 × 390 page): High 2.9 ms
median (1688 × 780 px), Medium 2.1 ms (1266 × 585), Low 1.6 ms (844 × 390).
For scale, an uncapped 3× phone would draw 2532 × 1170 = 2.96 M pixels,
2.2× High's and 4× Medium's. **No phone has been measured yet.** The text
HUD (F3 / F4) is no longer built on frames where it is hidden. Simulation
and server tick rates are unchanged.

**Nostr on phones.** Rumble uses NIP-07 only (`window.nostr`), unchanged.
It works wherever the browser provides `window.nostr`: a mobile browser
that runs a NIP-07 signer extension, or a Nostr app's built-in browser
that injects one. Plain Android Chrome and iOS Safari without such an
extension have none: Connect Nostr then says so in plain words ("This
browser has no Nostr signer (NIP-07)… Rumble never asks for your private
key. You can keep playing as a guest."). Guest play never needs Nostr.
No key is requested, stored or generated. Remote signing (NIP-46,
"bunker" or Nostr Connect) is the way to serve signer-less phones and is a
**separate future milestone**, not part of M12.

**Tests.** `control/touch.test.ts` (stick direction, magnitude, dead zone,
run, quantisation, response curve; fingers apart; once per press; cancel
and releaseAll; struggle strokes vs keys and the cap; stick wiggle;
Climb / Let go / push-away through `tickLedge`; banana aim speed and
throw gating; button roles per moment; touch intent = keyboard intent,
over `parseClientMessage`, and a forged vector cut to one),
`client/touchControls.test.ts` (with a stand-in DOM: hidden is deaf; move
and press at once; cancel, lost capture, blur, hidden page and
orientation change release; hiding releases unread presses; words and
roles follow the moment; no context menu or selection; when touch is
offered; when to ask for rotation), `net/touchHost.test.ts` (through the
authoritative host: keys and touch move the fighter the same; a touch
player breaks free no sooner than the cap; a forged message is clamped),
`view/quality.test.ts` (profiles, ratio caps, the budget's steps,
hysteresis and ignored stalls; the field of view per aspect), and the
mobile no-signer words in `client/identity.test.ts`.

**Known limitations.** Validated only in desktop Chrome with forced touch
mode and same-origin iframes of phone sizes (640 × 360, 844 × 390,
390 × 844, 1024 × 768): that checks layout, not touch hardware, real
safe areas, a real on-screen keyboard or mobile GPUs. In that session the
Chrome window was reported hidden to the page, so live movement was
verified through the host tests and local-mode stepping, not by dragging.
iPhone Safari has no element Fullscreen API (no button there). A device
in a 30 fps power-saving mode will make Auto step the ratio down. Tablets
upright are not asked to rotate. In local mode the touch controls drive
P1 only, and the cue's touch wording shows for both keyboard players.

**Manual device validation** (to do): `npm run serve` on the LAN, open
`http://<LAN IP>:8080/` on each phone (and a desktop in the same room).
On a small and a large Android phone (Chrome), an iPhone (Safari) and a
tablet, in landscape: (1) the start card, Play, Host and Join by code
(field: capitals, the keyboard does not hide it); (2) move in every
direction, walk slowly, run at the rim, jump, punch while moving, grab
and Throw; (3) get grabbed and Break free by tapping, then by wiggling;
(4) on Skyfall or Factory catch a ledge, Climb, then Let go; (5) get
knocked out, aim a peel, Throw three, see the cooldown and "none left";
(6) open the session panel mid-match: the controls vanish and nothing
stays held; switch apps and come back; receive a call or pull down the
notification shade mid-move; (7) turn the phone upright: the rotate
overlay, the match still running; back to landscape; (8) the scoreboard,
the round messages and cues are readable and do not cover the
fighters; the notch and home indicator cover nothing; (9) Graphics: note
the fps at Auto, Low, Medium, High (and `rumble.measureRender()` from a
remote inspector if available); (10) Connect Nostr without a signer: the
explanation, guest play continues; with a signer-capable mobile browser,
if available: proof, profile, Blobbi picker; (11) a desktop keyboard
player in the same room sees nothing different.

### 15i. Gameplay physics and mobile polish (M12.1, IMPLEMENTED — AWAITING MANUAL VALIDATION)

From the first desktop and real-iPhone playtest of M11.1 + M12. No new
arenas, combat systems or rules; the protocol is unchanged.

**Root causes found** (each measured before it was fixed, with temporary
probes over hundreds of bot matches and thousands of scripted crossings):

1. *"Launched extremely high at junctions."* A falling tile or pad
   (an ANIMATED Havok body) reset in the middle of its fall was swept back
   up with `setTargetTransform`: 1.76 m in one 1/60 s step, +106 m/s.
   Havok keeps an animated body's velocity, and the piece, now at rest,
   was never driven again: it kept +106 m/s for the rest of the match.
   Every fighter that touched it (crossing onto a corner tile, or along
   its seam) met a floor "rising" at 100 m/s and left at ~50 m/s (62 m/s
   peak; about 30 times in 20 bot matches on Frozen Lake; Skyfall's pads
   alike). Fighter-to-fighter contact, friction swaps, seams between flush
   boxes and capsule inertia were each ruled out on the exact replayed
   step. The fix is at the physics layer (`sim/arenaBody.ts`): a piece
   only ever sweeps *down* (a real fall that carries what stands on it);
   any return is a teleport; a piece not moving this step has no velocity.
   Seams between flush static boxes were tested separately (every seam of
   every arena, 8 angles, walk and run, alone, against an opponent and
   carrying): no lift (< 1.5 m/s, < 15 cm, and the only hops found were
   the sweepers' solid bars, by rule). A one-surface floor mesh was tried
   and removed: it changed nothing measurable.
2. *Climbs that lurched.* The climb drove the capsule in a straight line
   from the hang to the top, through the platform's corner; Havok pushed
   it out and the drive, chasing the line, reached 12-18 m/s. Now two
   legs (`sim/ledge.ts climbPoint`): straight up clear of the wall, then in
   over the top, at most 6 m/s; the hang spring closes at most 4 m/s.
3. *"Grabs look strange."* Three things: (a) the hold spring had no feed-
   forward of the anchor's own motion, so a carrier turning swung the
   anchor away and the body trailed it by 19-27 cm; (b) its catch-up was
   unbounded in speed, so a large error (a grab from mid-jump) yanked the
   body up at up to 6 m/s; (c) online, your carrier is drawn from
   prediction (now) and the body you hold from interpolation (~100 ms
   ago), so it trailed your hands by its speed times that delay. Fixed:
   the anchor velocity (the carrier's, with its vertical part, plus the
   hold's swing as a smoothed turn rate) is fed forward; the spring closes
   at most 3.2 m/s; the body you carry is drawn at the server's offset
   from you at the same interpolated moment (`client/carryView.ts`,
   presentation only). Measured: 4-5 cm off the anchor through a steady
   turn (was 19-27 cm), settles within 3 cm; peak lift 3.2 m/s (was up to
   6.15).
4. *"Bots throw much farther."* No mechanical difference. The throw is
   `throwBase 3.0 + throwGain 1.0 × the carrier's speed along the throw`,
   through the same impact path, for anyone. Measured over 523 bot throws:
   no-power impact 3.69 on average (speed along 0.64 m/s), thrown 1.7 m
   from the rim on average, facing out within ~20°, 67 % ring-outs. A
   person who throws standing still gets 3.0 (19 % less) and usually not
   toward a void; walking the load toward the edge gives the bot's
   numbers. A test replays a bot's carry-and-throw as a person's intents
   and gets the same impact and the same landing to the centimetre. What
   looks like strength is timing and aim (and the hold direction lagging
   a fresh turn by up to 3.5 rad/s, for bots and people alike).
5. *Ledges hard to understand.* Walking off an edge always caught it;
   running off almost never did (Skyfall 8 of 30 rims, Factory 0 of 10):
   at run speed the body was 1.06 m out when its feet came low enough,
   beyond the 0.9 m reach. The reach is now 1.15 m (`LEDGE.reachOut`
   0.75): walking and running off catch on every rim (31 / 31 and 10 / 10;
   the other 3 land on a lower floor). A body airborne from its own jump
   catches only an edge it moves toward (falling short of the far side),
   never the one it leapt away from. Knocked down or thrown, a body still
   never catches: falling stays a risk. Bots that leaned toward a target
   across a broken bridge walked off, caught, climbed back and leaned in
   again for ever (a round that never ended); bots now leap a gap in
   ATTACK as they did when seeking.

**Ledge feedback.** A grip bar over a hanging fighter's name tag (green,
amber, then red and blinking), and a glow along the edge it holds, for
everyone; the cue names the keys ("Space: climb up · G: let go · grip");
a CLIMBING state in which the touch buttons are dimmed ("Climbing…");
the help says when a catch happens.

**Safari.** iOS Safari zooms on a quick double tap and starts pinches
even where `touch-action` forbids them. The controls and the look area
now cancel `touchstart`, `touchmove`, `touchend` and Safari's `gesture*`
events themselves (the pointer events the controls read still arrive).
Only the game's surfaces do this: the body no longer carries
`touch-action: none`, so cards and menus scroll and zoom as any page and
the site's pinch zoom is not disabled. Remaining limits: a pinch that
starts on a card or a chip still zooms the page (deliberately); iOS may
still show its edge-swipe gestures (back, home indicator), which no page
can disable.

**Camera on touch.** Left thumb the stick, right thumb the buttons, any
other finger dragged across the rest of the arena turns the camera round
the fight, horizontally only (`control/look.ts`; 0.0068 rad per CSS
pixel, eased at 28/s, no felt lag). One finger owns the look by pointer
id; the stick's and the buttons' fingers cannot reach it. The shared
camera's target, distance, bounds and drop lines are unchanged; only its
yaw turns, and the stick is camera-relative, so "up" stays "away from the
camera" at every angle (tested at 16 yaws). A ⟲ button (shown once the
view is turned) and Settings → Camera recenter it. Desktop keeps
Babylon's own mouse orbit. Camera rotation is presentation: nothing of it
reaches the server.

**Settings.** A ⚙ button beside Help (top right on touch, bottom left on
desktop) opens a compact card: Graphics (Auto, Low, Medium, High; the
active one marked; the live render size, ratio, shadow map and fps),
Performance (an FPS counter, remembered as `rumble:fps`), Camera
(recenter; touch only) and Display (Full screen where the browser has the
API, standard or webkit-prefixed; otherwise how to get rid of the bars).
Opening it hides and releases the controls; closing it fires nothing
(the controls act on touch-down, the close button on click). The choice
is remembered (`rumble:graphics`); Auto's own adjustments never change a
fixed choice.

**Sharpness (iPhone).** The page renders at `CSS size × pixel ratio`.
On a 3× iPhone at the old phone Auto (cap 1.5) that was half the screen's
resolution each way. Now: Auto on a phone starts at ×2 (1.8× the pixels)
and steps down when frames are slow; High draws the screen's own ×3.
Effective scale per level on a 3× phone: Low ×1, Medium ×2, High ×3, Auto
×2 → ×1; on a 2× screen: Low ×1, Medium ×2, High ×2, Auto ×2. Desktop
measurements (this Mac, 932 × 430 page, GPU-synchronised): Low 1.7 ms,
Medium 2.4 ms, High 2.8 ms median per frame. **Nothing was measured on an
iPhone**; Settings shows the live fps there.

**Full screen and the home-screen app.** iPhone Safari has no Fullscreen
API for page elements (iPad Safari has the prefixed one, which is used).
The way to lose Safari's bars on iPhone is the home-screen app: M12.1 adds
`public/manifest.json` (`display: fullscreen`, `orientation: landscape`,
`start_url: /rumble.html?network=1`), icons (180, 192, 512, a 512 maskable and a 32 favicon, rendered from the game's own canonical purple adult Blobbi by the dev page `icon.html` / `src/playground/renderIcon.ts`; regenerate with `npx vite --port 5199` and `/icon.html`) and the iOS
meta tags. **No service worker** is registered: nothing is cached, so the
app can never run an outdated multiplayer client (pages are served
`no-cache`, assets by hash); it needs the network like the page does, and
connects to the same server over `ws://` / `wss://` on its own origin.
Caveats: a home-screen app has its own storage on iOS (the saved Nostr
login, graphics choice and remembered Blobbi are separate from Safari's),
and browser extensions, NIP-07 signers included, do not run in it. A
future PWA milestone would decide on a service worker (network-first for
pages, a version check against the server's protocol before using any
cached client), install prompts, and update notices.

**Tests.** `sim/junctions.test.ts` (pieces at rest after a reset mid-
fall; every seam of every arena; bot matches on all four arenas with no
upward speed or step beyond the rules), `sim/carry.test.ts` (grab lift,
anchor tracking through turns, repeated grabs / escapes / throws / drops
on the move, the bot-versus-person throw replay and the throw rule, run-
off catches, no catch of a leapt-from edge, knocked-down bodies fall, the
climb path and drive, bot-only Skyfall matches ending),
`client/carryView.test.ts`, `control/look.test.ts` (look ownership,
direction, release; movement after rotation), `client/fullscreen.test.ts`,
and additions to `client/touchControls.test.ts` (look and stick together,
recenter, Safari's events cancelled on the controls only) and
`view/quality.test.ts`.

**Manual checklist (desktop and a real iPhone).** (1) Cross every bridge
and seam of every arena walking, running and carrying: no hop. (2) Let
Frozen Lake's corner tiles fall and the round end mid-fall; walk onto them
next round: no launch. (3) Carry someone and turn: they stay in your
hands; throw while walking toward an edge vs standing. (4) Run off a
Skyfall or Factory edge: you catch it; the grip bar and the edge glow
show; climb (Space / Climb) and let go (G / Let go); a jump away from an
edge does not catch it. (5) iPhone: double-tap Punch / Jump / Grab / Break
free fast: no zoom; drag the stick hard: no scroll; drag on the arena to
turn the camera while moving; ⟲ recenters. (6) ⚙: switch Auto / Low /
Medium / High and compare sharpness and fps; turn the FPS counter on;
reload: both remembered. (7) Add to Home Screen; open from the icon: no
Safari bars, landscape, the match connects. (8) A desktop player in the
same room notices nothing different.

### 16. Invites are not access control

- An M8C invite is a **social message**. It carries a room link and
  creates **no** exclusive room access.
- The room code remains sufficient to join, as for any room.
- A possible future **M8C.1** could add invite-only rooms with
  server-issued capabilities, maybe recipient-bound. That is **not
  implemented**, and nothing today is an access token.

---

## 17. UI principles

Normal gameplay stays minimal (`client/shell.ts`):

| Layer | Contents |
| --- | --- |
| Persistent | session chip (room · server label · connection dot), compact scoreboard (names, score pips, power), identity chip (`Guest · Connect Nostr` / name), `H Help` |
| Contextual | the centre message (ring-outs, round and match results, with names), the struggle bar when you are held, toasts (joins, leaves, copied, created) |
| On demand | the session panel (room code, share link, Copy / Select link, Host, Join, Invite a friend, players, identity, server) and help (`H`) |
| Loud | a centred banner only when play is impossible (offline, missing room, refused), with what to do |
| Debug | F3 (colliders, reach, state), F4 (the text HUD and network numbers) |

- Buttons never take keyboard focus (Space and Enter stay jump).
- Text fields own the keyboard only while focused.
- Healthy state is quiet; error state is loud.
- Copy link copies in one click where the browser allows it (https and
  localhost). On plain-http LAN pages, where the Clipboard API doesn't
  exist, it becomes **Select link**.
- The UI SHOULD NOT return to a permanent card-heavy HUD without
  evidence.
- Local mode keeps its text HUD (§ Contradictions).

---

## 18. Security and trust boundaries

| Boundary | Rule |
| --- | --- |
| Server vs client | The server decides; clients send intent. |
| Nostr identity vs gameplay | A proven pubkey labels a slot; it decides nothing. |
| Visual vs physics | Visuals follow; they never feed back or change stats. |
| Game auth vs relay AUTH | Different challenge, `relay` tag, channel and signer; MUST NOT cross (§14). |
| Server claims vs trust | Name and operator are claims; only TLS proves an official host name; forwarded headers are ignored. |
| Room code vs secret | A code is an address, not a secret. |
| Signer vs key custody | NIP-07 holds the key; Rumble never asks for, makes, stores or logs an nsec. |
| One-time wrapper key vs identity key | NIP-59 wrapper keys are made per wrap and dropped; they are not identities. |
| Private invite vs access control | An invite grants nothing (§16). |
| Inbox setup vs silent changes | A kind 10050 is published only on an explicit confirm, only when none exists; an existing list is never replaced or merged. |
| Received messages vs privacy | Decryption only after an explicit check or an explicit per-identity consent, bounded, local; unrelated messages are never shown, stored or logged. |
| Automatic checking vs joining | Consent to check is not consent to join: Join stays a click; a pause or a refusal is never retried without one. |
| Finding people vs identity | A name or a NIP-05 identifies, the pubkey is the identity: every row shows a short npub, a NIP-05 only once confirmed, no badge from metadata alone; the follow list is read, never written; selection never sends. |
| Blobbi identity vs gameplay | A Blobbi is its kind 31124 at the owner's address, read only, through the kit's rules; a chosen Blobbi is a visual preference held locally and decides nothing in play. |
| Blobbi identity vs form | The identity persists unchanged; the Rumble form is temporary, derived from the address alone (the kit's seed rule), deterministic, never published, and never a gameplay difference. |
| Declared look vs verified ownership | A look binds to the sender's proven pubkey and the server derives its seed from that pubkey's own Blobbi address; existence, stage, name and legacy colours are the owner's declaration, cosmetic only, never checked against a relay. |
| Casual vs value-bearing | Participant-hosted is fine for casual; stakes need a neutral server (§9). |
| Untrusted input | Profile, relay and server text is rendered as text only; URLs are validated; nothing navigates automatically. |

---

## 19. Validation status

| Milestone | What | Evidence |
| --- | --- | --- |
| M1–M6 | Havok sandbox → 2 players → holds, tumbles → orbs → power as push → Arena 1 + sweeper → 4-player local rumble | Automated tests and scripted headless checks; developed and played locally; accepted as the base for later milestones. No formal playtest record in the repo. |
| Gameplay Pass 1 | Grab struggle | Tests and scripted checks; tuning accepted **pending real playtest** (§4). |
| Visual Pass 1 | Floating garden arena | Screenshots and frame-time parity checks during development; accepted. |
| M7A | Authoritative headless match | Tests; headless runs reproduce. |
| M7B | First authoritative networked match | Tests; local multi-browser play. |
| M7C | Prediction and interpolation | Tests and measurements under simulated lag; **passed the user's manual multiplayer playtest**. |
| M7D | Real network hosting | **Real LAN multi-machine play and a real remote Internet player**: fluid, no meaningful lag noticed. |
| M8A0 | Nostr social research | Reviewed and approved. |
| M8A | Nostr identity | **Real NIP-07 extension**: proof accepted, profile shown (`danidfra`), disconnect back to Guest mid-match. |
| M8B | Rooms, server identity, UI cleanup | **Manual multi-room test**: private room V4BU with two players, OPEN isolated, real NIP-07 auth inside the room, empty-room cleanup, steady 60 ticks/s. Follow-up `44179d7` (Copy vs Select link) verified in Chrome on localhost and LAN http. |
| M8C-A | Private invites: sending | **Real interop**: Rumble → real NIP-17 relay → **Anagram** showed the readable kind 14; no-10050 fallback and LAN-link warning confirmed. |
| M8C-B | Private invites: receiving | **Real two-identity test**: Danidfra (Rumble) sent; NotASage (Rumble, real extension) checked invites, the extension decrypted, the invite card appeared, and **Join** entered Danidfra's room. |
| M8C-B.1 | Inbox setup (kind 10050) | **Real two-identity test** (2026-10-09): Nostr Farm (no 10050, real extension) approved the setup; NIP-42 AUTH signed for `auth.nostr1.com`; the list published; Danidfra's invite received, decrypted (after the extension's decrypt permission) and **Join** entered the room. |
| M8C-B.2 | Automatic invite checking | **Real two-identity test** (2026-10-09): consent given, the invite arrived with no click, card and badge shown, Join entered the room; the setting survived reload and reconnect. |
| M8C-C | Choosing whom to invite | **Real two-identity test** (2026-10-09): Danidfra's follows listed, NotASage found by name and selected, the invite sent, received automatically, Join entered the room. |
| M9A | The player's Blobbis, a local choice | **Real test** (2026-10-09): owned Blobbis listed, one selected, restored after reload, no leak across identities, default restored, guest play unchanged. |
| M9B | Adult Rumble forms | Automated tests; **partly validated for real** (2026-10-09): selecting a Blobbi changes the local fighter, V1/V2 Blobbis get their adult forms, the choice persists across reloads and manual reconnection restores it. **Still open**: the animation checks (facing, grab arm pose, carried attachment, throw release, foot contact, transitions), geometry cleanup, room navigation and game reconnect. |
| M9C–M9F | Looks for everyone, identity presentation, picker, lifecycle | Automated tests, and a **real two-browser test** (2026-10-10): two proven players with different Blobbis saw each other's forms, a change mid-match and the default were followed, a guest played beside them, Nostr disconnect / reconnect behaved. **Not yet tested for real**: spectators, a late joiner, room switching with a form, the server restarting. |
| M10A–M10E | Online play: servers, public rooms, links, deployment, UX | Automated tests (endpoints, official / own / community servers, the choice and links, protocol version and incompatibility, origin refusal, listed / unlisted rooms, the listing over the socket and its rate limit, full rooms, server-aware links); the container builds from the Dockerfile here only as a file (not run). **Awaiting real online validation**; nothing deployed. |
| M11A–M11F | Arena chaos, vertical survival, eliminated-player interactions | Automated tests (registry, geometry, pieces, the match on every arena, host rotation, the socket, links and listings, ledges, belts, ice, peels, bots), headless bot matches finishing on all four arenas, `npm run bench` before and after, and a visual check of each arena in Chrome. **IMPLEMENTED — AWAITING MANUAL VALIDATION** (§15f). |
| M11.1 | Gameplay polish and balance: geometry, scale, grab, ledges | Automated tests (geometry rules, walkable transitions, the grab exchange, escapes, immunities, ledges), headless matches on all arenas with escapes happening, bench, Chrome screenshots of the flat bridges and the cue. **M11.1 IMPLEMENTED — AWAITING MANUAL GAMEPLAY VALIDATION** (§15g). |
| M12 | Mobile support: touch controls, responsive HUD, landscape, graphics quality | Automated tests (stick, touch pad, roles, struggle parity and cap, ledge, peels, cleanup, a stand-in DOM, through the authoritative host, quality and field of view); typecheck, build, headless matches on all four arenas, bench; Chrome screenshots of phone- and tablet-sized viewports with forced touch mode; render cost measured on a desktop GPU only. **M12 IMPLEMENTED — AWAITING REAL DEVICE VALIDATION** (§15h). |
| M12.1 | Physics and mobile polish: no launches, holds, throws parity, ledges, Safari gestures, touch camera, settings, sharpness, home-screen app | Root causes measured with temporary probes (bot-match censuses, replayed steps, seam sweeps, throw statistics, ledge censuses); automated tests (junctions, carry, parity, ledges, look, fullscreen, touch DOM, quality); headless on all four arenas; bench; Chrome screenshots at 667 × 375, 844 × 390 and 932 × 430 with forced touch. **M12.1 IMPLEMENTED — AWAITING MANUAL VALIDATION** (§15i); nothing tried on a real iPhone yet. |
| L4.7B.1 | Pre-deployment configuration: compose passes TRUSTED_PROXIES (exactly the project network's fixed gateway, not "private") and ROOM_IDLE_MINUTES, numeric settings checked at start, images tagged by commit (RUMBLE_TAG required, revision label), a non-destructive update / side-by-side / rollback procedure | Automated tests reading compose.yaml, .env.example and the Dockerfile against what the server reads (a mutation that drops a variable fails them), the trust rule (gateway only, not the container, other bridges, LAN, tailnet, loopback), numeric settings; the production bundle started locally with the example settings and the smoke check passed. **compose / Docker not run here (no Docker on the Mac); nothing deployed.** |
| L4.6-FIX1 | Frame stalls: the face's skin lookups cached (blinks and expressions no longer stall the page), an honest FPS counter | Root cause from CPU profiles in local headless Chrome (menu, plaza 1 and 8, private room, combat with server bots and with three human clients, before and after); automated tests on real kit Blobbis (accuracy over blinks and expressions, no new lookups on later blinks, bounded lattice, fighter face equals uncached), frame meter tests. **Desktop headless only; awaiting manual validation.** |
| L4.5B | Security and privacy: identity proofs only to trusted servers (with consent elsewhere), no other players' relays followed, proxy header validation and TRUSTED_PROXIES, fairer connection caps near full, deployment checklist | Automated tests (identity gate, trust store, URL rejection, directory, address rules, proxy headers, IPv4 / IPv6 grouping, connection caps, relayed and replayed proofs, malformed messages); local headless Chrome with a stand-in extension against a recording fake server (unknown server: no extension call, no challenge, no proof; trusted server: unchanged). **Awaiting manual validation; nothing deployed.** |
| L4.4B | Graphics and GPU cost: face meshes cast no shadow, 1024 skin | Automated tests on real kit Blobbis (caster selection over 24 different Blobbis, no duplicates, own skins and materials, nothing left after joining, leaving and look changes); local headless Chrome before / after on fixed scenes (draw calls, casters, texture estimates, render time, pixel comparisons). **No real device; awaiting manual visual validation.** |
| L4.5A | Room exhaustion protection: per-network room cap with a near-full reserve, reclaim of long-empty rooms when full, idle-room closing with warnings, header loopback not exempt, bounded limiter and refusal logs | Automated tests over real sockets (`roomCapacity.server.test.ts`) and room manager tests; the audit's exhaustion reproduced locally before the fix and repeated after it. **Awaiting manual validation; no change to deployment.** |
| L4.4A | Combat input reliability: pacing and press counts, keyboard focus, jump buffer / coyote, punch buffer, grab window | Automated tests (pacer, a virtual-clock page → rate limit → host → match run at 30–240 FPS with keys and the stick, lossy links, the gate, the windows, replays, focus); local headless Chrome before / after on loopback servers (desktop at native, 144 and 240 Hz; phone-sized emulation with touch). **Awaiting manual gameplay validation; no real iPhone yet.** |
| M9B.1 | Nostr session restoration | Automated tests. A first real run found two bugs: a restore could sit at "Restoring Nostr…" for the 60 s prompt timeout, and an unanswered discovery erased the saved Blobbi choice. Both fixed (bounded restore; discovery reports whether relays answered; the choice is never removed by a query). **Awaiting renewed real validation** (§13, §15b). |

---

## 20. Frozen decisions

"Frozen" means: **do not redesign without concrete evidence** from
testing, correctness, security or product requirements. It does not mean
immutable forever.

- **Arena 1's size and layout**, and the sweeper's role (the other M11 arenas are not frozen: tune them on evidence).
- **The current grab struggle** (6 reversals, about 1.2 s, no throw
  windup; M11.1 set the immunities to 1.2 s freed / 1.6 s thrown, the
  carrier to a walk, the hold to 2.5 s at most).
- **The authoritative WebSocket architecture** (intent in, 60 Hz server,
  20 Hz snapshots, prediction and interpolation).
- **No preventive lag compensation.**
- **No WebRTC / P2P architecture.**
- **Identical gameplay body for every Blobbi** (morphology is visual
  only).
- **The M8A identity flow** (NIP-07, connection-scoped proof over the game
  socket, Guest default).
- **M8B rooms** (OPEN plus code-addressed private rooms, in memory, 120 s
  grace, `/play/CODE`, `PUBLIC_URL` canonical). Amended 2026-10-11: a
  private room may run the lobby lifecycle (§10a); the addressing is
  unchanged and OPEN stays continuous.
- **The M8C-A send protocol** (kind 14 in a seal and gift wrap, the
  10050-only inbox, the `b` marker, 30-minute expiry, no self-copy).
- **The M8C-B receive behaviour** (explicit check, bounded newest-first
  decryption, marker-only recognition, unrelated messages discarded,
  explicit Join).
- **The M8C-B.1 inbox setup** (offered only with no list, suggested
  relays, a strict re-check, one explicit confirm, no retries by itself).
- **The M8C-B.2 consent model** (one preference per identity and origin,
  nothing decrypted before Enable, a pause never retried without a click,
  consent to check is not consent to join).
- **The M8C-C people finder** (exact identifiers first, read-only follows,
  two validated search relays re-matched locally, selection never sends).
- **The M9A Blobbi model** (kind 31124 at the owner's address through
  `@blobbi-kit/core`, modern only, newest per address, a local choice,
  nothing published).
- **The current minimal HUD** structure.

---

## 21. Roadmap

| | |
| --- | --- |
| **Completed** | M1–M6 · Gameplay Pass 1 · Visual Pass 1 · M7A · M7B · M7C · M7D · M8A0 · M8A · M8B (+ clipboard follow-up) · M8C-A · M8C-B · M8C-B.1 · M8C-B.2 · M8C-C · M9A |
| **In validation** | M9B: adult Rumble forms (§15c; animation checks open) · M9B.1: Nostr session restoration (§13; the automatic restore still fails intermittently, diagnostics in place) · M9C–M9F: remaining multiplayer cases (§15d) · M10: online play (§15e; awaiting a real deployment) · M11: arenas, pieces, ledges, belts, ice, banana peels (§15f; implemented, awaiting manual validation) · M11.1: gameplay polish and balance (§15g; implemented, awaiting manual gameplay validation) · M12: mobile support and touch controls (§15h; implemented, awaiting real device validation) · M12.1: physics and mobile polish (§15i; implemented, awaiting manual validation) |
| **Next** | A first official server, deployed from the compose file, and the real online validation |
| **Possible after** | M8C.1: invite-only rooms / capabilities, if justified · M8D: public discovery, if justified · M9: real Blobbi identity and character selection · M10: sats, LNbits, rewards |
| **Insert when useful** | NIP-46 remote signers (does not block M8C; the way to serve phones without a NIP-07 signer, §15h) |

---

## 22. Idea radar (non-normative)

None of this is designed or decided.

- **Room social and room chat.** Room-level communication is on the
  radar. Candidates include:
  - ephemeral chat over the room's authoritative WebSocket;
  - a Nostr-associated room conversation;
  - private or encrypted room communication.

  **No architecture is chosen**: whether chat is Nostr or WebSocket,
  encrypted or not, persistent or not. That needs its own design
  discussion: history, membership, privacy, moderation, player-hosted
  servers, and whether chat outlives a match.
- **Public games and server discovery (M8D):** server-signed, expiring
  room announcements; NIP-89 handler; optional NIP-38 "playing" status
  (M8A0 §8, §10, §11).
- **Presence:** no standard exists; in-room presence is already a server
  fact (M8A0 §8).
- **Player hosting made easier:** a desktop host app with an automatic
  tunnel, or an outbound rendezvous relay (M8A0 §13).
- **A shared Nostr package** (`src/social/` lifted out, e.g. as
  `@blobbi-kit/nostr`), once more apps need it (M8A0 §17).
- **Fighter appearance from a player's Blobbi**: the choice (M9A) and the
  local form (M9B) exist; sharing it with the room (M9C) is next.
- **Editing an existing inbox list.**
- **Invite accept/decline over kind 21059**, proof-of-work on wraps
  (M8C0); user-editable search relays (a NIP-51 kind 10007 list, as
  Amethyst reads).
- **Arena 2** with a larger or different layout.

## 23. Non-goals

- Nostr as realtime gameplay transport or gameplay authority.
- WebRTC / peer-to-peer play.
- Public matchmaking before it is justified. (A room's own lobby, §10a, is not matchmaking: it keeps M8B addressing and lists nothing new.)
- Sats or payments before their milestone.
- Gameplay, physics or networking inside `blobbi-kit`.
- Competitive advantage from Blobbi morphology.
- A general-purpose Nostr messaging client.
- Pasting, generating, storing or logging a user's nsec.

---

## Contradictions and stale prose found while writing v1

Current code wins; these are documentation gaps, not redesign requests.

1. **README, "Blobbi Rumble" command block:** labels `npm run server` as
   "(one match)". Since M8B the dev server hosts rooms too (OPEN by
   default).
2. **README, "Limitations":** dates from the Visual V0 playground ("the
   character controller is a stand-in, not Havok", "no instancing"). It
   describes the playground, not Rumble, which uses Havok and thin
   instances.
3. **README gameplay prose:** "The HUD shows each player's multiplier,
   score…" and "R restarts" are true of **local mode** (text HUD; R
   restarts only after a match). In network mode the text HUD is F4-only
   and the scoreboard shows that information; the next match starts by
   itself.
4. **`NOSTR_SOCIAL_ARCHITECTURE.md` §1–§16:** the research plan. It
   differs from what was built, and each difference is recorded in its own
   "as built" sections:
   - room routing via the URL query, not a `join` message;
   - `relay.ditto.pub` instead of `relay.primal.net` for lookups;
   - the invite tags (the `b` marker; no `subject`, no `["rumble",…]`
     tags);
   - a separate `challenge` message rather than a challenge in `welcome`.

   Read those sections as history.
5. **Relay connection cap:** the "at most 8 open relay sockets" rule holds
   for lookups. During an invite send, the short-lived inbox connections
   (at most 3) can briefly push the total past 8, as recorded in the
   M8C-A "as built" notes.

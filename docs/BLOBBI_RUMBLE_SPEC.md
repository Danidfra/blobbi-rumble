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
  requests wait in the match until a step takes them.
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
    also `challenge`, `auth` and `logout`.
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
| **Lifecycle** | A private room lives while anyone is connected to it, then **120 s** after the last connection leaves; then its match is disposed. |
| **Storage** | In memory only. **A server restart ends every private room** (players see "Room … isn't here"). |
| **Limits** | 16 rooms (OPEN included), 8 connections per room (4 play, 4 watch), 64 in all, 5 new rooms per address per minute. Refusal codes: `4004` no such room, `4003` no new room, `1013` full. |

> **A ROOM CODE IS NOT A SECRET.** Current private rooms are
> code-addressed rooms, not access-controlled or cryptographically private
> rooms. Anyone with the code or link can join.

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
  is not a fall); the hands reach 0.5 m beyond the capsule (was 0.35); a
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
  grace, `/play/CODE`, `PUBLIC_URL` canonical).
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
| **In validation** | M9B: adult Rumble forms (§15c; animation checks open) · M9B.1: Nostr session restoration (§13; the automatic restore still fails intermittently, diagnostics in place) · M9C–M9F: remaining multiplayer cases (§15d) · M10: online play (§15e; awaiting a real deployment) · M11: arenas, pieces, ledges, belts, ice, banana peels (§15f; implemented, awaiting manual validation) · M11.1: gameplay polish and balance (§15g; implemented, awaiting manual gameplay validation) |
| **Next** | A first official server, deployed from the compose file, and the real online validation |
| **Possible after** | M8C.1: invite-only rooms / capabilities, if justified · M8D: public discovery, if justified · M9: real Blobbi identity and character selection · M10: sats, LNbits, rewards |
| **Insert when useful** | NIP-46 remote signers (does not block M8C) |

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
- A public lobby or matchmaking before it is justified.
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

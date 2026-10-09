# blobbi-3d

The playground for the procedural 3D Blobbi. The renderer itself is
[`@blobbi-kit/3d`](../blobbi-kit/packages/blobbi-3d), a package of blobbi-kit;
this repository consumes it and holds only what is not the renderer: a scene,
a stand-in character controller, presets, and the panel.

```
blobbi-kit identity / genome  ──►  @blobbi-kit/renderer     (2D, SVG)
blobbi-kit identity / genome  ──►  @blobbi-kit/3d           (3D, Babylon.js)
                                        ▲
blobbi-3d (this)  ── a page that asks the package for Blobbis and shows them
```

The question this repository answered: **can a procedural 3D Blobbi be
recognisably the same character as the 2D one, with an architecture that is
reusable for party games, farming games and social spaces?** Open the
playground and judge.

## Run it

```
npm install
npm run dev          # http://127.0.0.1:5177/
npm run check        # typecheck, tests, build
```

`@blobbi-kit/3d` is the published package from npm (0.1.0), resolved through
its `exports` to its `dist/`. There is no copy of the renderer here;
`src/consumer.test.ts` fails if the import ever resolves to a source path. To
work against an unpublished kit, `npm link` its `packages/blobbi-3d` (see the
note in `vite.config.ts`).

Playground: WASD / arrows to walk, Shift to run, Space to jump; drag to orbit,
wheel to zoom. The panel picks a seed (the canonical Blobbi, the 2D lab's named
seeds, real nostr-pet dev seeds, or any pasted 64-digit seed), an expression,
sleeping, a pinned motion state, and a lineup of eight presets to compare.

## Blobbi Rumble

```
npm run dev          # http://127.0.0.1:5177/rumble.html            local: the match runs in the page
npm run server       # ws://127.0.0.1:8787                          the authoritative server (one match)
                     # http://127.0.0.1:5177/rumble.html?network=1  a network client (open several)
npm run serve        # http://<this machine>:8080/                    hosted: built game + WebSocket on one port (LAN / behind HTTPS)
npm run headless     # bot-only matches in plain Node, no browser (MATCHES=3 PLAYERS=4 HZ=60)
```

PLAYING WITH OTHER MACHINES (M7D): see [HOSTING.md](HOSTING.md). In short,
`npm run serve` builds the game and runs one Node process that serves it
and the match's WebSocket (`/ws`) on one port; friends on the LAN open
`http://<your LAN IP>:8080/`. Over the Internet, put any HTTPS tunnel or
reverse proxy in front of port 8080 and share its `https://` URL: the page
then connects to `wss://<same host>/ws` by itself.

ROOMS (M8B): one server hosts several matches. A plain visit plays the
open room; "Host a game" makes a private room with a short code (`A7F2`)
and a share link (`/play/A7F2`); "Join a game" takes a code. Empty rooms
close after two minutes. `PUBLIC_URL` is the server's one public address
(identity proofs, share links, `/.well-known/rumble.json`). The interface
is quiet while playing (chips, scoreboard, `H` help); see HOSTING.md.

NETWORK PLAY (`src/rumble/net/`, M7B): `npm run server` runs one
authoritative match in Node at a fixed 60 Hz and sends its state to every
client at 20 Hz over a WebSocket (`ws`). Each browser that connects takes
the first free slot (P1..P4) and plays it with any of WASD / arrows,
Shift, Space / Enter, F / K, G / L; empty slots are test bots, a fifth
client watches. Clients send only `{ t: 'input', seq, intent }` (and
pings); the server validates it, applies it to the connection's own
fighter, acknowledges the highest `seq` applied in each state, and decides
everything else. One-shot requests (jump, punch, grab) wait in the match
until a step takes them, so no later input can erase them. A client that
leaves hands its fighter straight back to its bot; a silent one (a frozen
tab) is let go of after a second. The next match starts by itself five
seconds after one is won.

SMOOTHING (M7C, `src/rumble/client/`). Remote fighters, the sweeper and
everything else are drawn from a buffer of states, 100 ms behind the
server's estimated clock, blended between the two states around that
moment (positions, quaternion orientations, facing, running timers;
discrete state never blends; resets, ring-outs and teleports snap; past
the newest state at most 50 ms of extrapolation, then a hold). Your own
fighter is predicted from your keys with the server's own steering and a
locomotion model fitted to the Havok match, and reconciled on every state:
acknowledged input is dropped, the rest is replayed from the server's
account (`ackTicks` says how much of the last acknowledged input the state
already contains), errors under 5 cm are left alone, larger ones glide
away at 10/s, over 1.2 m they snap. While the server has you (tumbling,
recovering, stunned, held, out, between rounds) nothing is predicted. A
punch swings at once when the server's last word says it can (cosmetic:
the hit is the server's); a grab shows nothing until the server holds.
F4 shows the network numbers; dev flags `?interp=0`, `?predict=0`,
`?delay=ms`. Server environment: `PORT`,
`HOST`, `TICK_HZ`, `SNAPSHOT_HZ`, and, dev only, `LAG_MS` / `JITTER_MS`
(added one-way delay each way); client: `?server=ws://host:port`.

THE AUTHORITATIVE MATCH (`src/rumble/sim/`) is the whole game with no
renderer, DOM, keyboard or clock: `createRumbleMatch({ havok, players })`,
`setInput(id, intent)`, `step(dt)` (returns the events it decided),
`snapshot()` (plain data), `restart()`. It owns the fighters' Havok bodies
in a physics world of its own on a Babylon `NullEngine` scene that is never
drawn, and decides movement, collisions, punch and grab targets, hits,
throws, orb pickups, sweeper hits, tumbles, eliminations, rounds, scores
and the match's winner. Intents (`sim/intent.ts`: a ground-plane
direction, run, and jump / punch / grab requests) are all it takes from a
player; the keyboard and the test bots are producers of them. Fighters are
named by stable match-local ids. The browser client (`main.ts` and
`view/`) steps the match once per frame and draws the snapshot: the visual
Blobbis, arena, orbs, sweeper, camera, HUD and F3 wireframes. The same
match runs in Node (`sim/havokNode.ts`, `headless.ts`) about 500 times
faster than real time.

A local party fight: four Blobbis from the package on one arena over a
void, the SAME normalized gameplay capsule owned by Havok for every one of
them (`src/rumble/profile.ts`, built from the kit's `BLOBBI_GAMEPLAY_PROFILE`
and nothing of any identity). Walk, run, jump, shove, punch, grab, drag and
throw. A ring-out eliminates a fighter from the round and the others play
on; the last Blobbi standing takes the point (the last ones falling on the
same frame is a draw, no point), first to three wins, R restarts, F3 shows
colliders, reach and everyone's state.

P1 and P2 share the keyboard; P3 and P4 are LOCAL TEST BOTS
(`control/bot.ts`), not an AI: a few states (seek an orb, seek a fighter,
attack, carry to the void and throw, recover), a look-ahead that turns away
from the outer rim (the floor is the union of the slabs: the seams where
the wings meet the centre are floor, and `rimDistance` measures to the real
void) and steers round the sweeper's post, a jump when the sweeper's leading face is about to arrive,
and a seeded sequence instead of dice. They answer with the same intent a
keyboard gives, so their fighters have exactly a person's body, combat and
power. `?players=2|3|4` plays fewer, `?bots=all` hands P1 and P2 to bots too.

Everyone fights everyone. A punch or a grab takes ONE fighter: of those in
the round within its reach and arc (a grab passes over a held, holding or
downed body), the nearest, the lower roster index on an exact tie
(`combat/melee.ts`). A hold names both sides, and a held or holding body
cannot be grabbed, so a body has one holder at most; a blow on either side
of a hold (a punch, the sweeper), a tumbling carrier or a ring-out ends it.
A held fighter can STRUGGLE FREE (`combat/struggle.ts`, `STRUGGLE` in
`tuning.ts`): reversing its movement, left-right-left-right (A/D, ←/→, or
any stick wiggle; the server only sees opposite directions, so the camera
never matters), builds escape progress; holding a direction, or repeating
one, does nothing, and useful input is capped at about 6.7 reversals a
second. Six counted reversals break the hold (about 1.2 s at a good pace,
0.8 s at the cap): both sides are cleared, the freed body is pushed a
little away, and for 0.6 s it cannot be grabbed again (it can still be
hit). The struggle runs after every attack of the step, so a throw on the
same step wins; a quick throw always beats it, a long carry does not. The
HUD shows your struggle bar while you are held; held Blobbis visibly
wriggle. Bots struggle with a person's rhythm (about 1.8 s) and, carrying a
wriggling victim near a rim, hurry the throw.
An eliminated fighter is parked out of play and hidden until the next round,
once its fall has crossed the fall line.

THE ARENA (`src/rumble/arena/layout.ts`) is three floor slabs: a wide,
safe centre (8 × 8 m) where everyone spawns (four at the corners of a
square around the middle orb, each facing it; three on a triangle; two
facing each other), and a narrower wing on each side (3.5 × 6 m), closer to
the rim. The right wing has THE SWEEPER: a low bar (0.22 m high) through a
post, turning at a constant 1.5 rad/s with a 2 m reach, moved by Havok as an
animated body so it shoves what it meets. A fighter met by the bar's
LEADING face takes its blow through the same impact path and hit / tumble
rule as a punch, with no player power in it: 1.4 plus 1.45 per m/s of bar
speed where it strikes, so near the post it shoves (about 3), in the middle
it hits about like a punch, and on the outer part (3 m/s at the tip, impact
5.75) it tumbles. A capsule just behind the bar (landed there after a jump)
is not struck. A jump clears it with timing near the tip; it cannot be
jumped near the post, where it is slow. The blow's direction is the bar's
motion there: on the half of the circle nearer the centre it sends you back
toward the centre, on the outer half toward the rim. The orbs follow the
zones: one safe and contested in the middle of the centre, one inside the
sweeper's circle on the half that sends you back toward the centre, one
deep in the left wing 0.6 m from the rim. Three, whatever the number of
fighters: scarcity is the point.

| | P1 | P2 |
| --- | --- | --- |
| move | WASD | arrows |
| run | left Shift | right Shift |
| jump | Space | Enter |
| punch | F | K |
| grab / throw | G | L |
| take an orb | walk into it | walk into it |

```
physics body (Havok capsule) ──► position / velocity / ground contact ──► visual Blobbi
```

The visual Blobbi follows its body every frame (root at the capsule's feet,
facing along its velocity, animator fed from the body's state) and never
feeds back. Punches, holds and throws are bounded velocity changes on the
bodies. A grab lifts the victim to a hold point in front of the grabber
that turns with the grabber at a bounded rate, so reversing direction
swings the held body around rather than through the carrier. A throw, or a
hard enough hit, frees the victim's capsule to tumble (a real rotation of
the body, not a ragdoll) with little steering authority, then a short
recovery rights it and hands control back; a lighter hit is a brief stun.
Every impact goes through one path (`combat/impact.ts`: base × power ×
attack × situation, clamped).

Three POWER ORBS sit on the arena (`tuning.ts`, `ORBS`). Walking into one
takes it (the nearest fighter when several arrive together, the lower
index on an exact tie), it bursts and is gone, and
it returns after a few seconds where no one is standing. Each orb is one
power level; the level's multiplier (`POWER`, +0.08 per orb, capped at
×1.48) is the player-power factor of the impact path, so punches and
throws hit harder, and a standing punch crosses the tumble threshold on
its own from the third orb. Power is also physical authority: while two
capsules touch, steering becomes a bounded spring toward the wanted
velocity (`PUSH` in `tuning.ts`), scaled by the fighter's push authority
(+5% per orb, capped at ×1.30), and the capsules' ground friction steps
aside for the contest, so a stronger fighter gains ground slowly in a
sustained shove (about 0.25 m/s at the cap, nothing at equal power) while
in a shoving match the wanted speed into the other body is capped at a
walk, so running adds nothing but the impact. In a shoving match, keys held
within about 26° of the line to the other body push along that line
(`PUSH.headOnCos`): each player pushes along its keys, so a few centimetres
of offset used to turn into a sideways shear that slid the two past each
other within a second; a diagonal or a sidestep still escapes. With more
than two touching, each body's contest is with the nearest one it touches. Power gives a very small
walk and run speed bonus (+1% per orb, capped at +6%), never the jump or
the air share, and touches nothing else (not reach, hold, mass or
recovery). It resets every round. The HUD shows each player's multiplier,
score, whether it is still in, and which are bots; a powered Blobbi has a
glowing ring at its feet, and every Blobbi carries its label over its head.

THE CAMERA frames every fighter still in the round and on the arena (a body
going over the rim stops counting once it drops below the floor): the
centre of the box around them, from a distance that grows with the box's
diagonal within bounds, the target kept over the arena when they spread
too wide.

The kit package knows nothing of Havok; everything game-side is `src/rumble/`.
Generic Nostr code (M8A) is `src/social/`, which imports only nostr-tools
and itself, so it can move to a shared package later:

```
src/social/
  signer.ts     NostrSigner (nostr-tools' Signer + method): NIP-07 detection, timeouts, classified errors, checked signatures
  auth.ts       NIP-42-style proof of a pubkey to any WebSocket service: challenge book, kind-22242 verification
  profile.ts    kind-0 parsing into a cleaned, bounded Profile; display-name fallback to a short npub
  directory.ts  pubkey → Profile: batched lookups, write-relay fallback, cache with age limits
  pool.ts       nostr-tools' SimplePool behind a hard cap of open relays and an idle close
  relays.ts     the lookup relays, relay URL checks, NIP-65 write relays (max 3)
  login.ts      the remembered login: { v, method, pubkey }, never a secret
  nip17.ts      NIP-17 sending: kind-14 rumor → kind-13 seal (the signer's NIP-44 + signature) → kind-1059 gift wrap (one-time key)
  inbox.ts      NIP-17 inboxes: find someone's kind-10050 relays; the app's only publisher (gift wraps to those relays, relay AUTH for them only)
  verify.ts     event verification on a fresh copy (no inherited cached verdicts)
  keys.ts       pubkey checks, npub, short npub
  avatar.ts     a deterministic identicon from a pubkey
```

The game:

```
src/rumble/
  sim/                the authoritative match, no renderer, DOM or input device:
    match.ts            RumbleMatch: setInput, step(dt), snapshot(), restart(); the step's order of play
    fighter.ts          one fighter's gameplay: body, facing, combat, fall, power, elimination
    intent.ts           the transport-neutral player intent
    snapshot.ts         the plain-data snapshot and the match's events
    physics.ts          Havok on a never-drawn NullEngine scene, stepped explicitly
    arenaBody.ts        the floor's collision
    sweeperBody.ts      the sweeper's animated bar and post
    read.ts             reading a snapshot back into combat predicates
    havokNode.ts        Havok's wasm from the package file, for Node
  net/                the network boundary (M7B):
    protocol.ts         the wire messages, validation of untrusted input, state freshness (pure); M8A identity messages
    host.ts             one match and its slots: people, bots, inputs, acks, the input timeout, auto-restart; the roster
    server.ts           the WebSocket server, the fixed 60 Hz loop with bounded catch-up, dev-only lag; the identity handshake; room routing
    rooms.ts            RoomManager: the open room and private rooms, one RumbleHost each; limits, grace period, disposal
    roomId.ts           short room codes (generation, validation; pure)
    serverIdentity.ts   PUBLIC_URL (the canonical address), SERVER_NAME, OPERATOR_PUBKEY, /.well-known/rumble.json (pure)
    serverTrust.ts      Local / Official / Community / Unknown server labels (pure)
    server-cli.ts       `npm run server` (dev, beside Vite)
    static.ts           the built game over HTTP (no traversal, / redirects to the game, /healthz)
    serve-cli.ts        `npm run serve`: the hosted game, page + /ws on one port
    endpoint.ts         which WebSocket URL a page uses (?server, VITE_RUMBLE_SERVER, dev :8787, else same origin /ws)
  client/             the browser client: presenter.ts (draws snapshots, diffing them for feedback),
                      local.ts (the match in the page), network.ts (a client of the server),
                      interp.ts (remote interpolation, pure), predict.ts (local prediction and reconciliation, pure),
                      connection.ts (connect / lost / retry / missing-room states and their words, pure),
                      room.ts (which room a page wants, its links; pure), shell.ts (the interface: chips, scoreboard, panels,
                      help, banner), dom.ts (text-only DOM helpers), identity.ts (the optional Nostr identity session),
                      invites.ts (the kind-14 invite message), inviteSender.ts (recipient → inbox → wrap → publish, as statuses)
  headless.ts         a whole bot match on the match alone (tests, measurements); headless-cli.ts runs it
  profile.ts          the one body every player has (collider, mass, speeds, acceleration, braking, air control, friction, damping, gravity)
  tuning.ts           combat, rounds and camera numbers, in one place
  roster.ts           who plays: labels, identities, keys or bot; ?players=, ?bots=all
  physics/            the gameplay capsule (upright, grounded by footprint raycasts, teleport, park, friction); capsule contact (pure); Havok's browser loader
  control/input.ts    one keyboard, two bindings; keys to a camera-relative intent (pure); the intent-source seam
  control/bot.ts      the local test bot: snapshot to an intent (pure), and its intent source
  control/mover.ts    intent to a bounded velocity change, applied as an impulse; a bounded spring while contested (pure)
  control/facing.ts   the facing follows the velocity (pure)
  control/animationBridge.ts  body state to the kit animator's input (pure)
  combat/impact.ts    one impact-strength path and the hit / tumble rule (pure)
  combat/combat.ts    punch, stun, grab, hold, throw, tumble, recovery: pure state and geometry
  combat/melee.ts     whom a punch or grab takes among several; who holds whom (pure)
  pickups/orbs.ts     the orbs: where, taken by whom, when back (pure)
  pickups/power.ts    a level's impact multiplier, capped (pure)
  rounds.ts           elimination, last Blobbi standing, rounds, the match (pure)
  arena/layout.ts     the floor's shape: slabs, rim, spawns (pure)
  arena/sweeper.ts    the sweeper: its angle, whom its bar strikes, the blow (pure)
  respawn.ts          fallen / wait (pure)
  view/               presentation only, drawn from snapshots and events:
    fighterView.ts      the visual Blobbi, its feedback, reach and power rings, name tag
    arenaView.ts        the lawn, rim trim, soil sides, rock undersides, sweeper patch, decoration
    sweeperView.ts      the garden spinner: candy pole, padded striped bar, spinning flower
    orbView.ts          spheres, discs, a burst when taken
    camera.ts           one shared camera: the box around the living, bounded distance, smooth follow (pure)
    theme.ts            an arena theme: colours only (GARDEN, a floating lawn in a bright sky)
    world.ts            camera, light rig and shadows, sky dome, clouds, distant islands
    decor.ts            where decoration may go, deterministic and clear of play (pure)
    debug.ts            F3 collider wireframes and the HUD
  main.ts             picks local or network mode
```

`window.rumble` exposes the scene, the match, the views and bots, the
event log, the latest `snapshot`, `step(n)` to drive frames by hand,
`key(code, down)` / `press(code)` to inject input, `script(i, intent)` /
`setBots(on)` to drive any fighter directly, and `holdsConsistent()`, for
scripted checks; `match.debugPlace(id, at)` puts a fighter somewhere.

## History

The renderer was grown here first (`src/blobbi/`, commits up to `aaffaa7`,
Visual V0) with its own port of the kit's identity, genome and morphology, then
extracted into the kit as `@blobbi-kit/3d`, which consumes the kit's canonical
engine (`@blobbi-kit/renderer/procedural`) instead of a port. The extraction was
proven by building the same seeds with both implementations in the real engine
and comparing every mesh's vertices and the painted skin, which matched exactly.

## What was inspected, and what it means for 3D (kept from Visual V0)

Repositories read (none modified): `blobbi-kit` (`packages/blobbi-core/src/blobbi-v3-identity.ts`,
`packages/blobbi-renderer/src/procedural/*`, `artwork/v3/*`), `blobbi-procedural` (the
V3 lab) and `nostr-pet` (consumer; dev seeds).

| Concept | In blobbi-kit | Here |
| --- | --- | --- |
| **Seed** | `sha256("blobbi:v1\|pubkey:d:created_at")`, 64 lower-case hex digits; the ONLY input the algorithm is defined over (`canonicalBlobbiV3Seed`). | `identity/seed.ts`: same canonical form; `seedFromLabel` reproduces the lab's label→seed rule so `pattern-0` is the same individual in both. |
| **RNG** | cyrb128 + sfc32, 12 warm-up draws; one KEYED stream per gene (`geneRng(seed, 'morphology.bodyWidth')`), `centered()` = mean of two uniforms. | `identity/rng.ts`: bit-for-bit port, pinned by fixtures the kit itself produced. |
| **Identity** | Two layers: EXPLICIT (colours, trait kinds, pattern, mark, belly, freckles) decided once by the seed at creation and then stored on the kind 31124 event; DERIVED micro-geometry re-derived from the seed under a frozen `visual_algorithm`. A stated field always wins. | `identity/identity.ts`: same shape as core's `BlobbiV3Identity`; `createBlobbiIdentity(seed)`, `resolveBlobbiIdentity(partial)` with `inferred[]`. A host passes the parsed event identity straight in. |
| **Genome** | 24 morphology genes in [-1, 1] (0 = canonical), trait genes always generated even when a trait is off, crown-crowding rules (horns displace ears; top horns move to the side when an antenna stands there). | `identity/genome.ts`: faithful port (egg genes left out). |
| **Colours** | OKLCH generator with per-hue lightness and chroma guardrails; `derivePalette` turns four trait colours into every painting role via offsets measured from the authored purple. | `identity/colors.ts`: port; the palette feeds the materials and the skin painter. |
| **Morphology** | genes → `base ± spread` in root units (the Adult V2 artwork's unit), small spreads: one species, many individuals. | `morphology/morphology.ts`: adult port, number for number (tested against the kit). |
| **Antenna** | `none/single/double`; side, crown position, fore/aft set, length, thickness, curvature, tilt, sweep, tip size, pair asymmetry. | Tapered tube on a quadratic from the crown surface, accent-coloured tip sphere. Sways in the rig. |
| **Horns** | `forehead/top/side`, honey colour (or brown/ivory on honey bodies), curl, tilt, roundness. | Soft cone (tube + dome) at the same anchors. |
| **Ears** | `round/pointed`, on the head's edge 11.5% down, tilt, flop, cheek-coloured inside. | Ellipsoid or soft leaf with a pink inner, pivoted at the root. |
| **Tail** | `nub/curl/leaf` low on the back, lift, curl. | Sphere / curling tube with accent tip / leaf ellipsoid. |
| **Pattern** | `solid/spotted/striped/gradient`: spots at degrees round the body on a flank and across the back; bands across the back; a deepening toward the base. Secondary colour. | Painted into the body texture at the same angles and heights (`markings/painter.ts`). |
| **Special mark** | `star/heart/sparkle/moon`, one region (forehead/chest/hip/shoulder) chosen by the seed among those the body leaves free. | Painted shape at the same place. |
| **Belly / freckles** | Lighter oval low on the front; three dots per cheek. | Painted. |
| **Expressions** | Six emotions as KEY POSES (mouth, brows, lid, iris scale, blush) blended by weight, in the face's own units; lids close continuously. | `face/expressions.ts` port; brows and mouth are flat ribbons on the skin (`face/stroke.ts`), lids are skin-textured patches that slide over the eye's dome. |
| **Eyes** | A white oval, iris and pupil set low and inward, two highlights on the lit side; lids as the kit's lid curves. | `face/eye.ts`: every part is a patch of the body's skin on one shallow dome (zero at the white's rim), so the eye faces where the skin faces and is the drawing from the front. Gaze slides the inner parts across the drawing; a blink is the lid curve descending over them. |
| **Adult vs baby** | Same genome, a stage plan scales and under-develops traits; the baby is a limbless floating seed. | Adult only in this prototype (the game character). The baby would be a second plan, not a second renderer. |
| **Determinism** | No `Math.random()` in anything identity-derived. | Same: tests pin seed → identity → genome → morphology → vertex data. Runtime animation and blinks use a per-instance seeded stream anyway. |

Properties that map into 3D: body width/height/top width/belly/roundness/lean
(the surface), eye size/spacing/height/tilt/pupil size, mouth width/height/curve,
brow height, cheek size, arm size/height, foot size/spacing, tuft size/tilt/
spread/length, every trait's micro-geometry, all four colours, pattern, mark,
belly, freckles. Nothing is forced where it would look wrong: the profile's
depth follows the kit's side silhouette (which the 2D side view also uses), and
the 2D view-specific effects (the stripes' sag, the lighting that "stays on the
viewer's left") are not reproduced, because in 3D the camera does that.

## Architecture

The renderer's layers live in the kit (`packages/blobbi-3d/src`): identity (the
kit's own), geometry (the body surface and parts in metres), markings (the skin
painter), face, materials, rig, animation, renderer (`createBlobbi3D` and the
gameplay profile). This repository is `src/playground/` only.

```
src/playground/      one scene, one controllable Blobbi, presets, the panel; no Blobbi logic
src/consumer.test.ts the playground consumes the package, by name, built
```

`createBlobbi3D(identityOrSeed, scene, options)` returns a handle with the
identity, genome, morphology, surface, rig, parts, face, materials, skin
texture, animator, meshes, and `setExpression`, `setSleeping`, `setGaze`,
`update(input)`, `dispose()`. `createCanonicalBlobbi3D(scene)` is the
comparison point (every gene at zero, the authored purple).

### The face and the traits in 3D

Every drawn feature answers "where is this in space?" with one rule: a point
of the front drawing lies on the body's skin under it (`surface.frontPoint`),
lifted along the skin's true normal by a small, fixed amount. Eyes add a
shallow elliptical dome that is zero at the white's rim; iris, pupil,
highlights and lids are laid on that same dome a hair above one another, so
nothing floats, clips or leaves the white at any gaze or angle. Strokes
(mouth, brows, the closed eye's line) are ribbons of the 2D stroke weight
with round caps. All patches have fixed topology and update positions only.

Traits are rooted at a MOUNT (a surface point with its normal) found by the
kit's own anatomical description, leave the skin along the normal and swing
to the kit's direction rule for their kind (`turnToward`), and follow the
kit's quadratic centre line (horns) or a cubic that emerges from the skin
(antennae, ears). Horns, ears and antennae are SWEPT meshes
(`geometry/sweep.ts`): rings along the centre line in a parallel-transported
(rotation-minimising) frame, so a curved horn bends without twisting, and a
root that is an AREA: every vertex of the first rings is placed a fixed
depth under the skin found along the mount's normal through it, blending
into the free sweep over a short run, so the whole perimeter grows out of
the body whatever its curvature. No world-space Euler angles are
accumulated.

### Units and frames

One root unit is 1/630.667 m: the canonical body is 1.0 m from base to
crown and the character stands 1.05 m. The character faces +Z. The kit
describes everything in the viewer's frame of the front drawing; `VIEWER_X`
in `geometry/units.ts` is the one constant that converts.

### Visual body vs gameplay body

`renderer/gameplay.ts` declares `BLOBBI_GAMEPLAY_PROFILE`: one normalized
capsule, reach, mass and speeds for every player. Visual morphology varies
by identity; the renderer never reads the profile and a game never derives
colliders from the mesh. The playground's controller moves that capsule and
the visual Blobbi follows it, which is the shape a Havok-backed controller
would take too.

### Animation

`BlobbiAnimator` turns `{ dt, speed, grounded, verticalVelocity, jumped,
landed, impact }` into a pose and eases between states. Walk and run plant
the feet and carry them back (no sliding), bounce and lean the body, swing
the arms and trail the soft parts; jump stretches, fall flails, land
squashes by the impact. `grab`, `push`, `stunned`, `ragdoll`, `getup` are
reserved names: a ragdoll is for the physics engine to pose.

## Tests

`npm test` here runs the consumer and playground tests; the renderer's own
tests (102 at Visual V0): the RNG, genome, identity, palette and adult
morphology against fixtures produced by blobbi-kit's own engine; determinism
(same seed → same identity, genome, morphology, vertex data); bounds and
clamping; stated-field precedence and `inferred`; expression blending and
lids; the body surface (height, width, profile depth, mapping of the face
and of a back spot) and its normals; the 3D face (deterministic eye
geometry, dome conformity, progressive lids, strokes a hair above the skin at
every key pose and blend, open-mouth fill, morphology extremes) and trait
attachment (roots on the skin, tips outside and above, mirrored pairs,
finite), the swept traits (every root vertex inside the skin and every wall
column crossing it once, for six trait kinds on six body shapes; the horn's
tip tangent turned by the kit's curl; rings centred on and perpendicular to
the centre line with no roll; determinism), all built with Babylon's
`NullEngine`; the animator's state choices and poses.

They run in the kit (`npm test` in blobbi-kit) on Babylon's `NullEngine`.

## Limitations

- Adult stage only; no egg, no baby.
- Lighting is Babylon standard materials (no PBR, no environment map).
- The skin texture repaints only when the blush changes; expressions that
  move the brows and mouth update meshes, which is cheap.
- The character controller is a stand-in (gravity and a flat floor), not Havok.
- No LOD, no instancing: one Blobbi is about 45 meshes and 10k vertices.
- The animation set is the demonstration set; there is no blend tree yet.

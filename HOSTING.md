# Hosting Blobbi Rumble

One server process hosts several **rooms**, each one authoritative match:
up to four players (P1..P4, bots in the empty slots) and a few spectators.
A plain visit plays in the **open room**; anyone can **host a game** (a
private room with a short code, e.g. `A7F2`) and share its link. No
accounts or sessions: whoever connects takes the room's first free slot.

## Modes

| mode | host runs | others open |
| --- | --- | --- |
| local dev | `npm run server` + `npm run dev` | `http://127.0.0.1:5177/rumble.html?network=1` |
| LAN dev | `HOST=0.0.0.0 npm run server` + `npm run dev -- --host 0.0.0.0` | `http://<LAN IP>:5177/rumble.html?network=1` |
| hosted (LAN) | `npm run serve` | `http://<LAN IP>:8080/` |
| Internet | `PUBLIC_URL=https://<public host> npm run serve` + an HTTPS tunnel/proxy to port 8080 | `https://<public host>/` |

`npm run serve` builds the game (`dist/`) and the server (`.serve/`), then
runs one Node process on `PORT` (8080) and `HOST` (0.0.0.0):

- the game: `/` (the open room), `/play/<code>` (a room's share link);
- the WebSocket: `/ws` (the open room), `/ws?room=<code>`, `/ws?create=1`;
- `/.well-known/rumble.json`: who the server is (below);
- `/healthz`: for whatever watches the process.

It prints the URL for each network interface. Use it for anything beyond
your own machine; the Vite dev server is not meant to be exposed (and
rejects unknown host names behind tunnels). In dev, `/play/<code>` works
on the Vite server too.

Environment: `PORT`, `HOST`, `STATIC_DIR` (dist), `MAX_CONNECTIONS` (64,
all rooms), `MAX_ROOMS` (16, the open room included), `TICK_HZ` (60),
`SNAPSHOT_HZ` (20), and the server identity: `PUBLIC_URL`, `SERVER_NAME`,
`OPERATOR_PUBKEY`. A malformed identity setting stops the server at start
with the reason.

## Rooms

- **Open room** (`OPEN`): always there; a plain visit lands here.
- **Private rooms**: made on request (Host a game). The code is 4
  characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O, 1/I/L),
  unique among the server's live rooms. The code is not a secret: anyone
  with it (or the link) can join.
- **Lifecycle**: a private room lives while anyone is in it, and for 2
  minutes after the last person leaves (a dropped player can come back),
  then its match is disposed. Rooms live in memory: **restarting the
  server ends every private room** (players see "Room … isn't here" and
  can go to the open room or host a new game).
- **Limits**: 16 rooms, 8 connections per room (4 play, 4 watch), 64
  connections in all, 5 new rooms per address per minute. Refusals:
  `1013 room full` / `server full` (the page retries), `4004 no such
  room`, `4003` (no new room now).
- **Isolation**: rooms share only the process. Inputs, states, scores,
  rounds, bots, restarts and Nostr identities stay in their room.
- **Identity**: a Nostr identity belongs to a connection (and so to its
  room and slot). The same pubkey on two connections is two separate
  players; nothing is restored on reconnect.

## Server identity and PUBLIC_URL

`PUBLIC_URL` is the one address people open (e.g.
`https://rumble.example`). It is the single source for:

- the address Nostr identity proofs must name (`wss://rumble.example/ws`);
- share links (`https://rumble.example/play/A7F2`), which the server hands
  to the page, so a player who opened a LAN address still shares the
  public one;
- the well-known document.

It is never taken from forwarded headers. Extra comma-separated addresses
are accepted in proofs only. Unset (LAN, dev), proofs are bound to the Host
each connection arrived with, and pages share their own address; fine on
a LAN, weaker in public. Plain `http://` is accepted for local and LAN
addresses; on a public host the server warns (put HTTPS in front).

`SERVER_NAME` is a display name. `OPERATOR_PUBKEY` (npub or hex) is who
runs the server, **as the server claims**: nothing proves the key's owner
agreed, and the label says so. The process is the authority over its
matches either way.

`/.well-known/rumble.json` (readable from any origin):

```json
{ "protocol": "blobbi-rumble", "version": 1, "websocket": "wss://rumble.example/ws",
  "capabilities": ["rooms", "nostr-auth"], "name": "…", "operator": "<hex>", "url": "https://rumble.example" }
```

`name`, `operator` and `url` appear only when configured.

The page labels the server it plays on: **Local server** (this machine, a
LAN, a tailnet), **Official server** (a Blobbi host over TLS, built-in
list: `rumble.blobbi.pet`), **Community server** (names an operator, as
claimed), **Unknown server**. Today's rooms are all casual: whoever runs
the server decides the match, which is why the label exists. A future
value-bearing mode will need a neutral server; rooms already record their
`mode` so the two cannot be confused.

Production example:

```
PUBLIC_URL=https://rumble.example SERVER_NAME="Daniel's garden" OPERATOR_PUBKEY=npub1… npm run serve
cloudflared tunnel --url http://localhost:8080      # or tailscale funnel 8080, a reverse proxy, a VPS
```

## Which server a page connects to (M10A)

A page knows a few game servers and uses one:

1. `?server=` in the page URL (a link, a test: this page only): `wss://`,
   `ws://`, or `http(s)://host` meaning `ws(s)://host/ws`;
2. the server the player chose in the session panel (remembered in this
   browser), if it is still known;
3. the first **official** server, from build-time configuration:
   `VITE_RUMBLE_SERVERS`, a JSON list of `{ "name", "url", "region"?,
   "operator"? }`, or the older `VITE_RUMBLE_SERVER` (one address). There
   is none by default: no production address is invented;
4. the page's own origin at `/ws` (`wss://` on an HTTPS page): the hosted
   game, where one process serves page and match; in dev, the dev server
   `ws(s)://<page host>:8787`.

**Community servers** are added by the player in the session panel
(Server → Game servers → Add server): a name and an address, kept in this
browser's localStorage (never a secret), at most 12; **Use** connects by
reloading the page at that server's open room. Nothing connects to a
server found in untrusted metadata (an invite, a profile, a relay).

**Addresses are checked strictly**: `ws://` or `wss://` only (other
schemes, credentials and fragments are refused); an **https page may only
use wss://**, never downgraded; plain `ws://` is accepted for local
addresses, and anywhere only in development.

**Compatibility**: the welcome carries `protocol` (1) and `features`
(`nostr-auth`, `rooms`, `looks`, `rooms-list`). A server speaking a newer
protocol than the page is shown as incompatible (no play, no retry loop); an
older one (no number) plays with fewer features. A server that refuses the
page's origin (4005) is shown as having turned the page away. Neither is
called "connected" merely because a socket opened.

The room goes in the query (`?room=A7F2`, `?create=1`, `&public=1`); the
page reads it from its own path (`/play/A7F2`) or `?room=`.

## Public rooms (M10B)

The session panel lists the server's **public rooms**: the open room and
every game hosted as public, with players / slots, watchers, the match's
phase and round, and whether a newcomer gets in. The list comes over the
existing socket (`{ t: 'rooms' }` → `{ t: 'rooms', rooms }`), at most 32
rooms, counts only (never who is in them), not more than once every 2 s
per connection, and the page asks only while the panel is open (every
10 s). There is no room database: the listing is the server's in-memory
room manager, as it is.

**Host a public game** lists the new room; **Host a private game** does
not: a private room is reached by its code or link only. A private room's
code is an **address, not a secret**: anyone who has it joins, as before.
Privacy here means "not browsable", not access control; invitations grant
nothing (see the spec, §16).

## Arenas (M11A)

A room is made with an arena: `?create=1&arena=<id>` (the ids are in
`src/rumble/arena/arenas.ts`; unknown or absent means the classic island)
and `&rotate=1` to move to another arena with each new match. The welcome
carries `arena: { id, rotate }` for players, late joiners and spectators;
the public listing names each room's arena; the page's host form offers
both. Nothing of an arena's geometry is sent: clients know it by id. A
player out of the round may send `{ t: 'throw', x, z }` (a banana peel);
the server judges it and refuses silently (see the spec, §15f).

## Links (M10C)

A room link is `https://<server>/play/<CODE>` on the server's `PUBLIC_URL`
(that server serves the page too). A page served elsewhere (a static site,
a dev page) that plays on another server appends `?server=<its address>`,
so the link selects the right server; the server address in a link is
checked like any other and, if refused, reported and not used. Old links
keep working. NIP-17 invitations carry the same link and are unchanged.

## Deploying the server (M10D)

The repo has a `Dockerfile` (multi-stage: builds the page and the server
bundle, runs them as `node` with production dependencies) and a
`compose.yaml`:

```
cp .env.example .env    # or export the variables below
docker compose up -d --build
curl -s http://127.0.0.1:8080/healthz
```

Environment (`npm run serve` and the container read the same):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | 8080, 0.0.0.0 | where to listen |
| `PUBLIC_URL` | unset | the one address people open (`https://rumble.example`); identity proofs must name it, share links and the well-known document use it. Set it when hosting publicly. |
| `SERVER_NAME`, `OPERATOR_PUBKEY` | unset | the server's claims (name; npub or hex) |
| `ALLOWED_ORIGINS` | unset (any) | browser origins that may connect, comma-separated; a browser from another origin is refused (4005); non-browser clients (no Origin) are let in. Usually equal to `PUBLIC_URL`. |
| `MAX_CONNECTIONS`, `MAX_ROOMS` | 64, 16 | caps, all rooms together / rooms at once |
| `TICK_HZ`, `SNAPSHOT_HZ` | 60, 20 | the simulation and the state rate |
| `STATIC_DIR` | dist | the built page |

**Without Docker** (a VPS with Node 22):

```
npm ci && npm run build
npx vite build --ssr src/rumble/net/serve-cli.ts --outDir .serve --logLevel warn
PUBLIC_URL=https://rumble.example ALLOWED_ORIGINS=https://rumble.example SERVER_NAME="…" node .serve/serve-cli.js
```

(`npm run serve` does the build and the run in one go.) Run it under a
supervisor that restarts it and passes SIGTERM, e.g. a systemd unit with
`ExecStart=/usr/bin/node /opt/rumble/.serve/serve-cli.js`,
`WorkingDirectory=/opt/rumble`, `Restart=always`, `EnvironmentFile=/opt/rumble/.env`
and `KillSignal=SIGTERM`. The process does not read `.env` itself: export
the variables, or let the supervisor (or compose) do it.

The process answers `GET /healthz` (`{ ok, clients, rooms, tick }`,
readable from any origin) and `/.well-known/rumble.json`; it closes
sockets and exits on SIGTERM / SIGINT (compose gives it 15 s); the
container's `HEALTHCHECK` and `restart: unless-stopped` bring it back.
Logs are compact lines about connections, rooms and abnormal traffic
(remote address and Origin; never message contents, never keys).

## HTTPS / WSS and the reverse proxy

The app never handles TLS and no certificates live in the repo. A browser
on an `https://` page must use `wss://`, which the page does on its own
origin, so terminate TLS in front of port 8080 with whatever you have, e.g.
`tailscale funnel 8080`, `cloudflared tunnel --url http://localhost:8080`,
`ngrok http 8080`, or Caddy / nginx / Traefik. The proxy must forward the
WebSocket upgrade for `/ws` (Caddy's `reverse_proxy localhost:8080` does;
nginx needs `proxy_http_version 1.1`, `Upgrade` and `Connection` headers,
and a read timeout above the 10 s heartbeat). Open only the proxy's port
(443) to the Internet; 8080 stays local to the host or the compose
network. Firewall: the host must accept inbound TCP 8080 for plain LAN
play (macOS asks the first time).

## Resources (M10D)

Each room is its own Havok world and `RumbleHost`; every room steps on the
same 60 Hz beat whether or not anyone is in it (a bot match plays on), and
empty private rooms close after 120 s. Spectators cost sends, not
simulation. `npm run bench` measures it here (`ROOMS=16 SECONDS=10`): on
the development machine this was written on, 16 rooms with four players
each took **0.42 ms per tick for all rooms together** (0.026 ms per room)
on the classic island and 0.44–0.45 ms on the M11 arenas (`ARENA=<id>`),
against a 16.7 ms budget; a state message is about 2.9 KB (2.6 KB before
M11), so a full room of 8 connections receives about 0.46 Mbit/s. That is one machine's
number, not a promise: run the benchmark where you deploy, and size
`MAX_ROOMS` / `MAX_CONNECTIONS` from it, leaving the sockets and the
operating system their share.

## Security notes

- Fresh-challenge Nostr identity on every connection; nothing weakened for
  convenience; guests always play.
- Origin validation (`ALLOWED_ORIGINS`), payload (4 KB) and message limits,
  per-connection rate limit, room-creation limit per address, heartbeat
  cleanup, bounded rooms and connections, strict parsing of every message.
- The server holds no keys: identity stays in the player's extension.
- Not provided: session recovery across a disconnect (a reconnect is a new
  connection with whatever slot is free), server-side proof that a
  declared Blobbi exists (the form binds to the owner's address; the rest
  is cosmetic), access control for rooms (a code is an address).

## Known bugs

- Automatic Nostr session restoration after a reload is intermittent
  (M9B.1); manual Connect / Reconnect works. Diagnostics are in the
  session panel in dev builds.

## Server limits

Besides the room limits: 4 KB per message · 120 messages/s per connection
(extra dropped; over 600 dropped in a second disconnects with 1008) ·
malformed messages counted and ignored · a client more than 256 KB behind
skips states, more than 2 MB behind is disconnected · ws ping every 10 s,
silent sockets terminated · one identity challenge per second per
connection · one room listing per 2 s per connection. The Origin header is
enforced when `ALLOWED_ORIGINS` is set, logged otherwise.

## Disconnects

A player who drops gets a banner, prediction stops, and the fighter goes
back to its bot at once. The page reconnects by itself (1, 2, 4, 8 s) to
the same room as a new connection and takes the first free slot, which
may be a different one; it says which.

## Nostr identity (optional)

Players may connect a Nostr browser extension (NIP-07: Alby, nos2x, …) to
show their name and picture instead of P1..P4; everyone else plays as a
guest. Rumble never asks for a private key.

The page asks the extension for the public key, the server sends a
one-use challenge, the extension signs a kind-22242 event naming the
challenge and the server's address (NIP-42 style), and the page sends it
**to the game server only** (it is never published to a relay); the
server verifies it. The server then tells everyone in the room "P2 is
pubkey X"; each browser looks up names and pictures on a few relays. The
server never connects to a relay.

## Private invites (M8C-A: sending; M8C-C: choosing whom)

In a private room, a Nostr-connected player can send a friend a private
invite: session panel → **Invite a friend** → paste an `npub` or
`nprofile` → **Send invite**. It is an ordinary NIP-17 private message
(kind 14, gift-wrapped), readable in any NIP-17 messaging app:

```
"<your name> invited you to Blobbi Rumble: https://rumble.example/play/V4BU"
tags: ["p", <friend>] ["r", <room link>] ["b", "blobbi:rumble:invite:v1"] ["expiration", <now + 30 min>]
```

- It goes only to the friend's NIP-17 inbox relays (their kind 10050
  list, at most 3). Without such a list nothing is sent: copy the link
  instead.
- Your extension is asked to encrypt (NIP-44) and sign the seal; an inbox
  relay that requires it gets a NIP-42 AUTH signed for that relay only.
  Nothing goes through the Rumble server; your game identity proof is
  never sent to a relay.
- It needs an extension with NIP-44 (Alby and nos2x have it). Without it,
  identity and play work as before; only invites are unavailable.
- An invite grants nothing: anyone with the link can join, as with any
  room link.

**Receiving (M8C-B):** a Nostr-connected player can open the session
panel → **Invites** → **Check invites**. Because NIP-17 hides what a
private message is, this decrypts a bounded number of recent gift wraps
(30, newest first, from the player's own kind 10050 inbox) on this device
with the extension's NIP-44. Only messages carrying the
`blobbi:rumble:invite:v1` marker become invites; anything else is dropped
at once and never shown, kept or logged. After the first check new
invites arrive live while the page is open (a toast and a ✉ badge). Each
invite shows the sender, room, destination host and server label, and
time left; **Join** (never automatic) switches room on this server or
opens the other server's page. The session remembers only the ids of
wraps it already judged, so a reload does not ask to decrypt them again.
Without NIP-44 the panel says why, and invites still reach the player's
Nostr messaging app.

**Setting up an inbox (M8C-B.1):** after connecting Nostr, Rumble looks
up the player's kind 10050 list (public; nothing decrypted). If there is
one it is used exactly as it is. If there is none, **Invites** offers
**Set up private invites**: the suggested relays (`auth.nostr1.com`,
`relay.nostr.net`, `nos.lol`) are checked without signing anything and can
be unticked; **Publish and set up** (only on that click) has the extension
sign the kind 10050 list, publishes it to the lookup relays, the player's
own NIP-65 write relays and the chosen inbox relays, and reads it back.
The result says whether the list is discoverable and how many inbox
relays accepted it. An existing list is never replaced or merged.

**Choosing whom to invite (M8C-C, implemented, awaiting real validation):**
in a private room, **Invite a friend** has one box, "Search name, npub or
NIP-05", and under it **People you follow** (the player's own kind 3,
read only, most recently followed first, 8 at a time with **Show more**).
An npub or nprofile names one person and is selected at once; a
`name@domain` is resolved by that domain (NIP-05) and selected; a name is
matched first among follows and cached profiles, then, after a short
pause, on two search relays (`relay.vertexlab.io`, `relay.ditto.pub`,
NIP-50), merged, ranked (exact name, then prefix, then contains; people
you follow first) and capped at 10. Every row shows the avatar, the name
and a short npub (names aren't unique: the npub is the identity), and a
NIP-05 only once its domain confirmed it. Selecting shows the person and
**Send invite**; nothing is sent without that click; **Change** picks
someone else. The invite itself goes through the M8C-A sender unchanged,
so "no private-message inbox" is reported the same way. Name search is
not complete: Nostr has no global name index, and the panel says so.

**Automatic checking (M8C-B.2, validated for real):**
once an identity with NIP-44 and an inbox is connected, Rumble asks once,
"Automatically check for Rumble invites?", with **Enable automatic
invites** / **Not now** (a small corner card, and the same question in
**Invites**). The answer is one preference per identity and per origin
(localStorage, one word; never a message). With it on, the same bounded
check starts by itself each time that identity connects (no click; the
remembered ids are skipped as before) and the panel says **Listening for
private invites**. If the extension refuses or does not answer a decrypt
request, checking **pauses** ("Automatic invites paused — decrypt
permission needed") and nothing is asked again until **Try again**. The
Invites section shows **Automatic invites: On / Off** with a switch;
turning it off closes the subscription at once and leaves **Check
invites**. Automatic checking is permission to check, not to join: Join
stays a click, and the kind 10050 list is never touched by it.

## The interface

While playing: a session chip (top left: room · server, a dot for the
connection), the scoreboard (top centre), an identity chip (top right:
"Guest · Connect Nostr" or your name), `H Help` (bottom left). Click the
session chip for the room code, share link, Host / Join, players, your
identity and the server. Round and match results show briefly in the
middle; a struggle bar when you are held. Errors (offline, a missing
room) are a centred banner with what to do. `H` help, `Esc` closes
panels, `F3` colliders, `F4` network numbers (the old text HUD).

Copying the share link: browsers allow one-click copy only on https pages
and localhost. On a plain-http LAN address (`http://192.168.1.4:8080`)
the button reads **Select link**: it selects the link and says which keys
copy it (⌘C / Ctrl+C). Behind HTTPS (a tunnel, `PUBLIC_URL=https://…`) it
is **Copy link**.

## Test plan to send a friend

1. Open the link the host sends you (`…/play/A7F2`, or the code via
   "Join a game"). Chrome, Firefox or Safari, with a keyboard.
2. The top-left chip shows the room code and a green dot. If it says
   watching, the four slots are taken.
3. Press `H` for the controls. Move WASD/arrows, Shift run, Space jump, F
   punch, G grab then G throw. Grabbed? alternate ← → fast.
4. Optional: click **Connect Nostr** (top right) if you have a Nostr
   extension, so the others see your name.
5. Press F4 and tell the host the NET line (ms, states/s).
6. Tell the host: did your Blobbi respond at once, did others move
   smoothly, any jumps or freezes, and the banner text if something failed.

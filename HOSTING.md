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

## Which server a page connects to

1. `?server=` in the page URL (`ws://`, `wss://`, or `http(s)://host` which means `ws(s)://host/ws`);
2. `VITE_RUMBLE_SERVER` at build time;
3. in dev: `ws(s)://<page host>:8787`;
4. otherwise the page's own origin: `ws://host/ws`, or `wss://host/ws` on an HTTPS page.

The room goes in the query (`?room=A7F2`); the page reads it from its own
path (`/play/A7F2`) or `?room=`.

## HTTPS / WSS

The app never handles TLS and no certificates live in the repo. A browser
on an `https://` page must use `wss://`, which (4) does automatically, so
terminate TLS in front of port 8080 with whatever you have, e.g.
`tailscale funnel 8080`, `cloudflared tunnel --url http://localhost:8080`,
`ngrok http 8080`, or Caddy/nginx (`reverse_proxy localhost:8080`; nginx
needs the `Upgrade`/`Connection` headers for `/ws`). Firewall: the host
must accept inbound TCP 8080 for LAN play (macOS asks the first time).

## Server limits

Besides the room limits: 4 KB per message · 120 messages/s per connection
(extra dropped; over 600 dropped in a second disconnects with 1008) ·
malformed messages counted and ignored · a client more than 256 KB behind
skips states, more than 2 MB behind is disconnected · ws ping every 10 s,
silent sockets terminated · one identity challenge per second per
connection. The Origin header is logged, not enforced.

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

## Private invites (M8C-A: sending)

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

**Automatic checking (M8C-B.2, implemented, awaiting real validation):**
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

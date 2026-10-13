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
`OPERATOR_PUBKEY`. A malformed setting (identity or, since L4.7B.1, a
number: `MAX_CONNECTIONS=6O` used to mean no limit at all) stops the server
at start with the reason.

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
- **Rooms (L4.1)**: OPEN (Quick Match) and PLAZA (the public plaza, 8 people) always exist and count toward the room limit.
- **Limits**: 16 rooms, 8 connections per room (4 play, 4 watch), 64
  connections in all, 5 new rooms per address per minute, 3 private rooms
  open per address at once, 10 wrong room codes per address per minute
  (then joining by code waits for the minute). Refusals: `1013 room full`
  / `server full` / `network full` (the page retries), `4004 no such
  room`, `4003` (no new room now, or too many codes tried).
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
cp .env.example .env    # the production values for rumble.blobbi.pet; adjust for another host
sed -i "s/^RUMBLE_TAG=.*/RUMBLE_TAG=$(git rev-parse --short HEAD)/" .env   # required: the image is tagged by commit
docker compose build && docker compose up -d
curl -s http://127.0.0.1:8080/healthz
docker compose exec rumble node scripts/smoke.mjs http://127.0.0.1:8080 "$(grep ^PUBLIC_URL= .env | cut -d= -f2)"
```

Environment (`npm run serve` and the container read the same):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT`, `HOST` | 8080, 0.0.0.0 | where to listen |
| `PUBLIC_URL` | unset | the one address people open (`https://rumble.example`); identity proofs must name it, share links and the well-known document use it. **Required when hosting publicly** (L4.5B): without it a proof only has to name the `Host` the connection claimed, so a server a player was lured to could relay this server's challenge and replay the player's answer here. |
| `SERVER_NAME`, `OPERATOR_PUBKEY` | unset | the server's claims (name; npub or hex) |
| `ALLOWED_ORIGINS` | unset (any) | browser origins that may connect, comma-separated; a browser from another origin is refused (4005); non-browser clients (no Origin) are let in. Usually equal to `PUBLIC_URL`. |
| `CLIENT_IP_HEADER` | unset | a header a trusted proxy sets to the player's address (`cf-connecting-ip` behind Cloudflare Tunnel), used for the per-address limits (connections, rooms, room codes) and the refusal lines of the logs. **Only** when nothing but that proxy can reach the port: anyone else could forge it. Unset: the socket's address. L4.5B: the header must hold one real IPv4 / IPv6 address (else the socket's counts). |
| `TRUSTED_PROXIES` | unset (any peer); compose: `172.31.250.1` | L4.5B: which peers may set `CLIENT_IP_HEADER`: `loopback`, `private` (any private network), exact addresses, IPv4 CIDRs. A header from any other peer is ignored (its own address counts). Unset, the header is believed from anyone, and the server warns at start. **Behind compose (L4.7B.1): exactly the project network's gateway** (`RUMBLE_GATEWAY`): every connection to the published `127.0.0.1` port, cloudflared's included, reaches the container from that one address. Not `private`, which would also believe any other private address that ever reached the container. |
| `ROOM_IDLE_MINUTES` | 20 | a private room nobody plays or moves in closes after this (warned 2 min and 30 s before); 0 turns it off |
| `RUMBLE_HOST_PORT` | 8080 | compose only: the host port, published on **127.0.0.1** only |
| `RUMBLE_TAG` | **required** | compose only (L4.7B.1): the image to build and run, `blobbi-rumble:<tag>`: the short commit being deployed (no `latest` fallback; the image also records it, `docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' blobbi-rumble:<tag>`). A rollback is the previous tag with `up -d --no-build`. |
| `RUMBLE_SUBNET`, `RUMBLE_GATEWAY` | 172.31.250.0/29, 172.31.250.1 | compose only (L4.7B.1): this project's own Docker network, a fixed range so its gateway is known. If the range is taken on the host, `up` stops with "Pool overlaps": choose another and set `TRUSTED_PROXIES` to the new gateway (all three together). |
| `MAX_CONNECTIONS`, `MAX_ROOMS` | 64, 16 | caps, all rooms together / rooms at once (1–10000, 2–1000; L4.7B.1: anything not a whole number in range stops the server) |
| `TICK_HZ`, `SNAPSHOT_HZ` | 60, 20 | the simulation and the state rate (compose fixes them at 60 and 20) |
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

## Production: rumble.blobbi.pet (Debian 13, Docker, Cloudflare Tunnel)

```
browser ──https / wss──► Cloudflare ──tunnel──► cloudflared (systemd, on the host)
                                                 └─http / ws──► 127.0.0.1:8080 ──► container :8080 (node, as user "node")
```

What the repository provides for it, and what it does not touch:

- `compose.yaml`: project **`blobbi-rumble`** (its own network `rumble`,
  172.31.250.0/29, gateway 172.31.250.1; no volumes, no host mounts), one
  service `rumble`, image `blobbi-rumble:<RUMBLE_TAG>`, published on
  **`127.0.0.1:8080` only** (the LAN and the Internet cannot reach it; only
  processes on the host, i.e. cloudflared). Restart `unless-stopped`; health
  check on `/healthz`; limits 2 CPUs, 1 GB, 256 processes; runs as the
  image's unprivileged `node` user with a read-only filesystem (a 16 MB
  tmpfs `/tmp`), every capability dropped and `no-new-privileges`; logs
  capped at 3 × 10 MB. It shares nothing with other containers (Ditto or
  any other): different project, network and port.
- `.env.example`: the production settings (`PUBLIC_URL` and
  `ALLOWED_ORIGINS` = `https://rumble.blobbi.pet`, `CLIENT_IP_HEADER` =
  `cf-connecting-ip`, `TRUSTED_PROXIES` = the gateway, `ROOM_IDLE_MINUTES`,
  the network range; `RUMBLE_TAG` empty, to be set). Every variable in it
  reaches the container or compose (a test checks that compose passes every
  setting the server reads). No secrets exist: the server holds no keys. `.env`
  is ignored by git and excluded from the Docker build context, as are
  `*.pem` / `*.key`.
- `scripts/smoke.mjs` (also in the image): checks the page, `/healthz`, the
  well-known document, the home-screen app files, the WebSocket from the
  public origin, a foreign origin refused, and a Nostr proof bound to the
  public address accepted (one bound to `ws://127.0.0.1:8080/ws` refused).
- Nothing on the host changes: no router ports, no firewall rules, no SSH
  or Tailscale changes, no new host services. The tunnel already exists.

**1. Transfer the project** (from the development Mac; nothing is pushed
anywhere). Either a git bundle (keeps history, so tags and rollbacks by
commit work):

```
# on the Mac
git bundle create /tmp/blobbi-rumble.bundle master
scp /tmp/blobbi-rumble.bundle <user>@<server>:~/
# on the server, the first time
git clone ~/blobbi-rumble.bundle ~/blobbi-rumble
# later updates
cd ~/blobbi-rumble && git pull ~/blobbi-rumble.bundle master
```

or a plain copy of the working tree: `rsync -a --delete --exclude node_modules --exclude dist --exclude .serve --exclude .git --exclude .env ./ <user>@<server>:~/blobbi-rumble/`.
Build **on the server** (x86-64): the image is built from source there, so
nothing architecture-specific travels (an image built on an Apple-silicon
Mac would be arm64 unless built with `--platform linux/amd64`).

**2. Configure and start** (on the server):

```
cd ~/blobbi-rumble
cp .env.example .env                 # review it: PUBLIC_URL, ALLOWED_ORIGINS, CLIENT_IP_HEADER, TRUSTED_PROXIES, RUMBLE_HOST_PORT=8080
git status --short                   # empty: the image is tagged by this commit, so build exactly it
sed -i "s/^RUMBLE_TAG=.*/RUMBLE_TAG=$(git rev-parse --short HEAD)/" .env   # tag the image by commit (required; rollbacks)
docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'   # 172.31.250.0/29 must be free
docker compose config | grep -A3 ports   # must show host_ip: 127.0.0.1, published "8080"
docker compose config | grep -E 'TRUSTED_PROXIES|subnet|gateway'   # 172.31.250.1, 172.31.250.0/29, 172.31.250.1
docker compose build
docker compose up -d
```

A copy of the working tree (rsync) has no `.git`: set `RUMBLE_TAG` by hand
to the commit it was copied from (`git rev-parse --short HEAD` on the Mac).
The bundle is better: the tag is then the commit, provably.

**3. Verify** (on the server):

```
docker compose ps                                     # rumble: Up … (healthy) after ~20 s
ss -ltnp | grep ':8080'                               # 127.0.0.1:8080 only, never 0.0.0.0:8080 or [::]:8080
curl -s http://127.0.0.1:8080/healthz                 # {"ok":true,"clients":…,"rooms":2,"tick":…}
docker compose logs rumble | grep -E 'believed only from|WARNING'   # "believed only from 172.31.250.1"; no WARNING
docker compose exec rumble node scripts/smoke.mjs http://127.0.0.1:8080 https://rumble.blobbi.pet
docker compose exec rumble node scripts/smoke.mjs https://rumble.blobbi.pet      # the whole path, through Cloudflare
```

From any machine: `curl -s https://rumble.blobbi.pet/healthz` and
`curl -s https://rumble.blobbi.pet/.well-known/rumble.json` (its `url` must
be `https://rumble.blobbi.pet`). In a browser: open
https://rumble.blobbi.pet, play (the session chip shows the room; F4 shows
`wss://rumble.blobbi.pet/ws` and the round trip); open it in a second
browser or on a phone and see each other; with a NIP-07 extension,
Connect Nostr: the session panel shows the identity verified (the proof
names `wss://rumble.blobbi.pet/ws`, which `PUBLIC_URL` makes the only
accepted address). Opening the game through `http://127.0.0.1:8080` on the
server itself is refused by `ALLOWED_ORIGINS` (4005) and its proofs would
name the wrong address: test through the public hostname.

**Logs and restarts:**

```
docker compose logs -f --tail=200 rumble    # connections, rooms, refusals, a 30 s summary; never keys or messages
docker compose restart rumble               # matches in progress end; pages reconnect by themselves
docker compose stop / docker compose up -d --no-build   # only this project's container and network
```

**Updates (L4.7B.1), keeping the previous version runnable:**

```
cd ~/blobbi-rumble
docker compose images rumble                          # the tag running now: note it (PREV)
cp .env .env.bak-$(date +%Y%m%d-%H%M)                 # the settings as they are
git pull ~/blobbi-rumble.bundle master && git status --short   # the new code (step 1); clean tree
NEW=$(git rev-parse --short HEAD)
sed -i "s/^RUMBLE_TAG=.*/RUMBLE_TAG=$NEW/" .env
docker compose build                                  # a NEW image blobbi-rumble:$NEW; PREV's image is untouched
docker compose up -d --no-build && docker compose ps  # seconds of downtime: the container is replaced
docker compose exec rumble node scripts/smoke.mjs https://rumble.blobbi.pet
```

Between `docker compose build` and `up` (recommended for the first L4.7
deployment), the new image can be tried beside the live one,
as a second project on another port and its own network range (nothing of
the live one changes; cloudflared is not involved, so this checks the
container, not the tunnel):

```
RUMBLE_TAG=$NEW RUMBLE_HOST_PORT=8081 RUMBLE_SUBNET=172.31.250.8/29 RUMBLE_GATEWAY=172.31.250.9 TRUSTED_PROXIES=172.31.250.9 \
  docker compose -p blobbi-rumble-rc up -d --no-build
docker compose -p blobbi-rumble-rc ps                 # (healthy)
docker compose -p blobbi-rumble-rc exec rumble node scripts/smoke.mjs http://127.0.0.1:8080 https://rumble.blobbi.pet
docker compose -p blobbi-rumble-rc down               # removes only that project's container and network
```

**Rollback**: back to the previous image, which is still on the host, with
no build (a build here would make an image of the *new* code under the old
tag; `--no-build` refuses instead if the image is gone):

```
docker image ls blobbi-rumble                          # PREV must be listed
sed -i "s/^RUMBLE_TAG=.*/RUMBLE_TAG=<PREV>/" .env      # or restore the .env.bak-… copy
docker compose up -d --no-build && docker compose ps
docker compose exec rumble node scripts/smoke.mjs https://rumble.blobbi.pet
```

The first update from a deployment made before L4.7B.1 (image tagged
`latest`, project on its default network): keep the running image under a
name first, `docker tag blobbi-rumble:latest blobbi-rumble:pre-l47`, so
`RUMBLE_TAG=pre-l47` is the rollback. Rolling back to it with this
compose.yaml puts the old image on the new network and passes it
`TRUSTED_PROXIES`, which it understands (L4.5B+); an image older than
L4.5B ignores it (a warning, not a failure). Nothing else needs to match:
there is no stored data (rooms live in memory) and the page and the server
come from the same image, so they never disagree; the protocol is version 1
before and after (L4.4A's press counts are optional both ways).

Keep two or three previous images and remove older ones one by one
(`docker image rm blobbi-rumble:<tag>`); never `docker system prune` on a
host with other services. Rooms live in memory: a restart, an update or a
rollback closes every room and match (players' pages reconnect to the open
room; private room codes are gone).

**Cloudflare Tunnel and long-lived WebSockets** (free plan; nothing paid
is needed):

- WebSockets go through tunnels and the free plan; the zone's WebSockets
  setting must stay on (it is by default).
- Cloudflare closes a WebSocket after about 100 s without traffic; a game
  connection is never idle (states 20 a second, pings every second).
- Cloudflare and cloudflared restart now and then (edge maintenance, a
  cloudflared update): open sockets drop. The page reconnects by itself
  (1, 2, 4, 8 s) as a new connection and may get another slot.
- Every connection reaches the server from cloudflared, so the server
  takes the player's address from `CF-Connecting-IP` (`CLIENT_IP_HEADER`);
  trusting it is safe only because the port is loopback-only. Inside the
  container every such connection comes from the network's gateway
  (172.31.250.1), the only peer `TRUSTED_PROXIES` believes. After the first
  real player: `docker compose logs rumble | grep -E 'conn [0-9]+ from net|ignoring cf-connecting-ip'`
  must show `from net <tag>` (the header is read) and never `ignoring
  cf-connecting-ip from …` (that would mean connections arrive from another
  address, e.g. rootless Docker: put that address in `TRUSTED_PROXIES`).
- The tunnel's origin is `http://localhost:8080`. The container listens on
  IPv4 loopback only; if cloudflared ever logs refused connections to
  `[::1]:8080`, change the origin to `http://127.0.0.1:8080` in the
  tunnel's configuration (a change to the host's tunnel: do it yourself or
  ask first).
- Pages are served `no-cache` and assets by content hash, so Cloudflare's
  cache never serves an outdated client; there is no service worker. If
  Rocket Loader or HTML minification are enabled for the zone, turn them
  off for this hostname (they rewrite scripts). A Cloudflare challenge page
  (Bot Fight Mode, Under Attack) cannot be shown to a WebSocket: keep such
  modes off for this hostname or connections fail.
- Latency: Cloudflare's edge sits between the players and the house; the
  F4 panel shows the measured round trip.

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
network (`compose.yaml` publishes it on 127.0.0.1 only). Firewall: the host must accept inbound TCP 8080 for plain LAN
play (macOS asks the first time).

## Resources (M10D)

Each room is its own Havok world and `RumbleHost`; every room steps on the
same 60 Hz beat whether or not anyone is in it (a bot match plays on), and
empty private rooms close after 120 s. Spectators cost sends, not
simulation. `npm run bench` measures it here (`ROOMS=16 SECONDS=10`): on
the development machine this was written on, 16 rooms with four players
each took **0.42–0.46 ms per tick for all rooms together** (0.026–0.029 ms
per room) on the classic island and 0.44–0.47 ms on the M11 arenas (`ARENA=<id>`),
against a 16.7 ms budget; a state message is about 2.9 KB (2.6 KB before
M11), so a full room of 8 connections receives about 0.46 Mbit/s. That is one machine's
number, not a promise: run the benchmark where you deploy, and size
`MAX_ROOMS` / `MAX_CONNECTIONS` from it, leaving the sockets and the
operating system their share.

## Security notes

- Fresh-challenge Nostr identity on every connection; nothing weakened for
  convenience; guests always play.
- Origin validation (`ALLOWED_ORIGINS`), payload (4 KB) and message limits,
  per-connection rate limit, per-address limits on connections, open rooms,
  room creation and wrong room codes, idle and heartbeat cleanup, bounded
  rooms and connections, strict parsing of every message, a CSP on pages,
  no address beside an identity in the logs (see Server limits).
- The server holds no keys: identity stays in the player's extension.
- L4.5B: identity proofs only go by themselves to trusted servers (above);
  `CLIENT_IP_HEADER` can be restricted to `TRUSTED_PROXIES`; near full (16
  places left of 64), one network may hold 4 connections instead of 8.
- Not provided: session recovery across a disconnect (a reconnect is a new
  connection with whatever slot is free), server-side proof that a
  declared Blobbi exists (the form binds to the owner's address; the rest
  is cosmetic), access control for rooms (a code is an address).

## Deployment security checklist (L4.5B)

For a public server, before it takes players (compose / `npm run serve`):

1. **`PUBLIC_URL`** set to the one public address (`https://rumble.blobbi.pet`): required (identity proofs are bound to it).
2. **`ALLOWED_ORIGINS`** set to that origin: other sites' pages cannot open the game's socket.
3. **The port reachable only through the proxy**: compose publishes `127.0.0.1:8080` only (never `8080:8080`); a VPS without Docker: listen on `127.0.0.1` or firewall the port.
4. **`CLIENT_IP_HEADER`** (`cf-connecting-ip` behind Cloudflare Tunnel): without it every player is the tunnel, one network for everyone (8 connections, 2 rooms, for the whole server). With it, it is only as safe as point 3.
5. **`TRUSTED_PROXIES`** (defence in depth): behind compose, exactly the project network's gateway, `172.31.250.1` (L4.7B.1; compose passes it, `.env.example` sets it; not `private`). The start-up log then says the header is believed only from it, and warns when it is unset. Check the first player's log line: `conn N from net <tag>` (not `net local`) means the header is read, and no `ignoring cf-connecting-ip from …`.
6. **Limits**: `MAX_CONNECTIONS` (64), `MAX_ROOMS` (16), `ROOM_IDLE_MINUTES` (20) as wanted (all passed by compose; a malformed number stops the server); the per-network caps are in Server limits.
11. **`RUMBLE_TAG`** set to the commit being deployed, and the previous image still listed (`docker image ls blobbi-rumble`): the rollback.
7. **TLS and HSTS** at the proxy (Cloudflare); the page sets its own CSP and frame protection.
8. **No secrets**: the server needs none (no private key, no token); `.env` holds settings only.
9. **Logs**: bounded by compose; connection lines carry a salted network tag, never an address beside a Nostr key; refusals (which carry no identity) name the address, at most 20 lines per 10 s.
10. **Official server list in the build** (`VITE_RUMBLE_SERVERS` / `OFFICIAL_HOSTS`): the servers the page signs in to without asking. Keep it to servers you run.

## Graphics problems and diagnostics

Before a network page connects it checks that the browser gives WebGL
(WebGL 2, else WebGL 1, as Babylon does), so a page that cannot draw never
takes a fighter. If it gets none, or the 3D engine fails to start, or the
graphics are lost mid-game and not restored within 6 s, the page shows a
full-screen explanation (no WebGL / blocked for this site / engine failed /
graphics lost), what to try (hardware acceleration, brave://gpu, Shields
and extensions, drivers, another browser) and details to copy; a page that
had joined closes its socket at once (the server gives the fighter to its
bot) and does not reconnect. A context loss the browser restores is ridden
out as before.

- `?debug=perf`: a small overlay with FPS, frame time, draw calls,
  triangles, the internal resolution, the WebGL version and, online, the
  latency. Loaded only when asked for; nothing of it runs otherwise.
- Development builds and this machine's own address only (ignored on a
  public host): `?webgl=1` forces WebGL 1, `?webgl=none` pretends there is
  no WebGL, `?webgl=fail` makes the engine fail after joining.

WebGL 1 works (checked in Chrome, online and offline, no shader errors,
the same draw calls and look). Its known differences: the soft shadows use
Poisson sampling instead of PCF (Babylon's own fallback: slightly grainier
shadow edges), and multisampled render targets are unavailable (the canvas
itself is still antialiased).

## Known bugs

- Automatic Nostr session restoration after a reload is intermittent
  (M9B.1); manual Connect / Reconnect works. Diagnostics are in the
  session panel in dev builds.

## Server limits

Per address (an IPv4 address, or an IPv6 /64; the socket's own loopback
is never limited, so behind a tunnel set `CLIENT_IP_HEADER` or every
player counts as the tunnel; an address from that header is always
limited, even one claiming to be loopback): at most 8 connections
server-wide and 4 in one room (a household can still put four fighters in
a room; nobody fills a room or the server), 2 private rooms open (1 once
only 4 places for private rooms are left), 5 new rooms per minute, 10
wrong room codes per minute. A connection that sends nothing for 2 minutes is closed
(`4008 idle`; a real page pings every second, so standing still never
counts) and the page reconnects. A connection's look is applied at most
once a second (the latest wins). These came out of the October 2026
security audit (H1, M1-M3).

Private-room capacity (L4.5A): when all 16 rooms are taken, a new game
takes the place of the private room empty the longest, if it has been
empty for 20 s (never a room anyone is in, never OPEN or PLAZA). A private
room where nobody has moved, pressed a button, used the lobby, changed a
look or arrived for `ROOM_IDLE_MINUTES` (20; 0 turns it off) is closed:
its players are warned 2 minutes and 30 seconds before, a match in
progress always counts as activity, and the page then says the room was
closed (`4009 room closed: inactive`). Staying connected or pinging is
not activity. Refusals are logged at most 20 lines per 10 s (the rest
summed up), and the per-minute limiters remember at most 4096 networks.

Logs: connection, room and identity lines show a network tag (a salted
hash of the address group, new on each restart), never the address beside
a Nostr key; only refusals, which carry no identity, name the address.

HTTP: every response has `nosniff` and a referrer policy; pages add a
Content-Security-Policy (scripts from this origin and WebAssembly only;
relays, https lookups and remote profile pictures allowed; no framing),
`X-Frame-Options: DENY` and a permissions policy. HSTS is left to the
proxy (Cloudflare's dashboard), not set here.

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

**Which server may see your identity (L4.5B).** A proof tells a game
server who the player is (their public key, and through it their
profile): never a secret, but not something to give to any server a link
points at. The page proves by itself (a remembered login on a visit, a
reconnect) only to the servers it is built to trust: the official ones
(`VITE_RUMBLE_SERVERS` / the built-in list), this site's own server, the
dev server, and exact addresses the player said yes to before. On any
other server (a `?server=` link, a community server) a remembered login is
not used (the extension is not even asked; the player is told once, and
the profile sheet offers "Use it on this server"), and Connect first says
what connecting shares and with whom, with "Stay a guest". A yes is kept
in this browser for that exact WebSocket URL only (another path, port or
host is another server; at most 16 are kept).

**Other players' profiles.** Names come from a few fixed lookup relays;
only the player's own profile may also be looked for on the player's own
relays: another player's relay list is never followed (it would let anyone
send every page that sees them to a relay they run). Other people's
pictures (any `https` URL their profile names, loaded with no referrer)
appear only where the player opens them: the invite people list, an
invitation card. In rooms and on the plaza, players are names (text) only.

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

# Hosting Blobbi Rumble

One authoritative match per server process, up to four players (P1..P4,
the rest are bots) and spectators. No accounts, rooms or sessions: whoever
connects takes the first free slot.

## Modes

| mode | host runs | others open |
| --- | --- | --- |
| local dev | `npm run server` + `npm run dev` | `http://127.0.0.1:5177/rumble.html?network=1` |
| LAN dev | `HOST=0.0.0.0 npm run server` + `npm run dev -- --host 0.0.0.0` | `http://<LAN IP>:5177/rumble.html?network=1` |
| hosted (LAN) | `npm run serve` | `http://<LAN IP>:8080/` |
| Internet | `npm run serve` + an HTTPS tunnel/proxy to port 8080 | `https://<public host>/` |

`npm run serve` builds the game (`dist/`) and the server (`.serve/`), then
runs one Node process: static files, `/healthz`, and the WebSocket at
`/ws`, all on `PORT` (8080) and `HOST` (0.0.0.0). It prints the URL for
each network interface. Use it for anything beyond your own machine; the
Vite dev server is not meant to be exposed (and rejects unknown host names
behind tunnels).

Environment: `PORT`, `HOST`, `STATIC_DIR` (dist), `MAX_CONNECTIONS` (16),
`TICK_HZ` (60), `SNAPSHOT_HZ` (20).

## Which server a page connects to

1. `?server=` in the page URL (`ws://`, `wss://`, or `http(s)://host` which means `ws(s)://host/ws`);
2. `VITE_RUMBLE_SERVER` at build time;
3. in dev: `ws(s)://<page host>:8787`;
4. otherwise the page's own origin: `ws://host/ws`, or `wss://host/ws` on an HTTPS page.

## HTTPS / WSS

The app never handles TLS and no certificates live in the repo. A browser
on an `https://` page must use `wss://`, which (4) does automatically, so
terminate TLS in front of port 8080 with whatever you have, e.g.
`tailscale funnel 8080`, `cloudflared tunnel --url http://localhost:8080`,
`ngrok http 8080`, or Caddy/nginx (`reverse_proxy localhost:8080`; nginx
needs the `Upgrade`/`Connection` headers for `/ws`). Firewall: the host
must accept inbound TCP 8080 for LAN play (macOS asks the first time).

## Server limits

16 connections (a 17th is closed with 1013 "server full"; the page says so
and retries every 10 s) · 4 KB per message · 120 messages/s per connection
(extra dropped; over 600 dropped in a second disconnects with 1008) ·
malformed messages counted and ignored · a client more than 256 KB behind
skips states, more than 2 MB behind is disconnected · ws ping every 10 s,
silent sockets terminated. The Origin header is logged, not enforced.

## Disconnects

A player who drops gets a banner, prediction stops, and the fighter goes
back to its bot at once. The page reconnects by itself (1, 2, 4, 8 s) as a
new connection and takes the first free slot, which may be a different
one; it says which.

## Test plan to send a friend

1. Open the URL the host sends you (Chrome, Firefox or Safari, a keyboard).
2. Wait for the top-left pill: `● online · you are P2 · 40 ms`. If it says
   watching, the four slots are taken.
3. Controls are in the bottom-left card (H hides it). Move WASD/arrows,
   Shift run, Space jump, F punch, G grab then G throw. Grabbed? alternate
   ← → fast.
4. Press F4 and tell the host the NET line (ms, states/s).
5. Tell the host: did your Blobbi respond at once, did others move
   smoothly, any jumps or freezes, and the pill text if something failed.

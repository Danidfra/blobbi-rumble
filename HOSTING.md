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
`TICK_HZ` (60), `SNAPSHOT_HZ` (20), `PUBLIC_URL` (see Nostr identity).

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

## Nostr identity (optional)

Players may connect a Nostr browser extension (NIP-07: Alby, nos2x, …) to
show their name and picture instead of P1..P4; everyone else plays as a
guest, exactly as before. Rumble never asks for a private key.

How it works: the page asks the extension for the public key, the server
sends a one-use challenge, the extension signs a kind-22242 event naming
the challenge and the server's address (NIP-42 style), and the server
verifies it. The server then tells every client "P2 is pubkey X"; each
browser looks up names and pictures on a few relays itself. The server
never connects to a relay, and relays being down only means short npubs
are shown instead of names.

**Set `PUBLIC_URL` when hosting publicly** (e.g.
`PUBLIC_URL=https://rumble.example npm run serve`): proofs must name that
address. Unset, the server accepts the Host each connection arrived with,
which is fine on a LAN or behind a tunnel that keeps the Host header, but
weaker (a malicious server could relay a proof made for it). If players
see "The proof named a different address", set `PUBLIC_URL` to the
address they open.

### Testing it with two browsers

1. `npm run serve` (or `npm run server` + `npm run dev`), open the game in
   **Browser A**, which has a NIP-07 extension (Alby or nos2x) with a test
   key that has a profile, and in **Browser B** (a private window, no
   extension).
2. A and B both show a small welcome card. In B click **Continue as
   guest**. In A click **Connect Nostr**; approve the extension's prompts
   (the public key, then a signature of kind 22242).
3. A's card says **Connected as <name>** with its npub; the player list
   (top left) shows A's slot with A's name and picture. B's list shows A's
   name too, and B itself as Guest. A's fighter tag shows A's name.
4. Both play a round: both Blobbis respond as before; press F4 for the
   NET (states/s, gaps) and NOSTR lines.
5. Reload A: its card says "not signed in on this server" (a remembered
   pubkey proves nothing); B shows A's new slot as Guest. Click
   **Continue as <name>**: verified again.
6. In A click **Disconnect**: A becomes a guest and keeps playing on the
   same slot; B shows Guest.
7. Optional: in A's extension, deny the signature: A shows the reason and
   stays a guest.

## Test plan to send a friend

1. Open the URL the host sends you (Chrome, Firefox or Safari, a keyboard).
2. Wait for the top-left pill: `● online · you are P2 · 40 ms`. If it says
   watching, the four slots are taken.
3. Controls are in the bottom-left card (H hides it). Move WASD/arrows,
   Shift run, Space jump, F punch, G grab then G throw. Grabbed? alternate
   ← → fast.
4. Optional: click **Connect Nostr** if you have a Nostr extension (Alby,
   nos2x), so the others see your name; otherwise **Continue as guest**.
5. Press F4 and tell the host the NET line (ms, states/s).
6. Tell the host: did your Blobbi respond at once, did others move
   smoothly, any jumps or freezes, and the pill text if something failed.

# Blobbi Rumble: Nostr social architecture (M8A0 research)

Status: research and plan, 2026-10-08. **M8A (identity) implemented
2026-10-09**, **M8B (rooms, server identity) implemented 2026-10-09**:
see "M8A as built" and "M8B as built" at the end for what changed from
this plan.
Starting point: M7D (`4cdd0a2`). Multiplayer has been validated on a real
LAN and with a real remote Internet player.

**The rule this whole document protects:**

```
Nostr                        identity · profiles · invites · room/server hints · presence (maybe)
  │  (says who and where, never what happened)
  ▼
Rumble authoritative server  slots · rooms · simulation · results
  │
  ▼
WebSocket                    intent in, state out (unchanged)
```

Nostr may say "Daniel invited Alice" or "room A7F2 exists at server X".
It must **never** be the authority for "Daniel punched Alice", "Daniel
won", "Daniel has 3 power" or "Daniel is owed 1000 sats". Those facts
belong to the game server. When they leave the server at all, they leave
signed by the server's key (see §14).

---

## 1. Current Rumble architecture (what M8 builds on)

- **`net/host.ts`, `RumbleHost`.** One match: four slots, P1..P4. Empty
  slots are played by bots, and a fifth connection spectates. It has no
  transport, takes raw text in through `receive`, and runs on a fixed
  `tick()`.
- **`net/server.ts`, `startRumbleServer`.** It builds **exactly one**
  `RumbleHost`. Around it sit the `ws` server, one global `clients` map,
  one 60 Hz loop, and one `broadcast()` of a single JSON state to every
  client. It also holds the limits (`SERVER_LIMITS`) and the logs.
- **`net/serve-cli.ts` (`npm run serve`).** Static `dist/`, `/healthz`
  and `/ws` on one port. TLS is handled by whatever sits in front.
- **`net/protocol.ts`.**
  - Client to server: `input` and `ping`.
  - Server to client: `welcome {you, players, tickHz, snapshotHz}`,
    `state`, `pong`.
  - There is no identity, no room, and no server identity anywhere.
- **`client/endpoint.ts`.** One URL, from `?server`, then
  `VITE_RUMBLE_SERVER`, then (dev only) `:8787`, then the page's own
  origin at `/ws`.
- **Per-match cost.** Each `RumbleMatch` has its own Havok world on a
  `NullEngine` scene, and all of them share one Havok wasm instance. The
  headless bot match runs at **0.037 ms per tick**, so one room at 60 Hz
  is about 2.2 ms of CPU per second, plus one `JSON.stringify` per state.
  CPU is not what limits multi-room hosting.

### What assumes one match

| Place | Assumption |
| --- | --- |
| `startRumbleServer` | constructs one host and ticks one host; `broadcast()` sends that host's state to *all* sockets |
| `clients` map, `stats`, `maxConnections` | global, not per room |
| `/ws` | no room selector; a connection joins "the" match on connect |
| `welcome` | no room id, no server identity |
| `RumbleHost` | matches restart forever; there is no room lifecycle (create, empty, expire) |
| `client/endpoint.ts`, `network.ts` | one URL, no room parameter |
| `serve-cli.ts` | health log for one host |

**Difficulty of multi-room hosting: low to moderate.** The expensive part
is already right: `RumbleHost` has no transport and one instance per
match is cheap. The `RoomManager` boundary sits **between `server.ts`
(socket shell) and `RumbleHost`**:

```
server.ts  (sockets, limits, logs)
  └─ RoomManager   create(opts) / get(id) / join(roomId, conn) / leave / tick all / reap idle
       └─ Room     { id, host: RumbleHost, clients, meta: { mode, visibility, createdBy, trust } }
```

- **Routing.** Use a first message `{t:'join', room, ticket?}` rather than
  `/ws?room=`. This keeps URLs clean and lets later auth ride the same
  handshake.
- **Default room.** A connection that sends no `join` goes to a
  **default room**, so today's clients and tests keep working unchanged.

**Can M8A ship without rooms? Yes.** Identity attaches to a *connection*,
then to the slot it holds. Rooms later just carry the same per-connection
identity. Nothing in M8A has to know how many matches a process runs.

---

## 2. Relevant existing code in our projects

A local audit of `~/Developer`, read-only. Blobbi Rumble itself has no
Nostr code.

- **Common stack (the MKStack template).**
  - `@nostrify/nostrify` + `@nostrify/react` + `nostr-tools ^2.13`.
  - `NostrLoginProvider` keeps logins (raw nsec included) in localStorage
    under `nostr:login`.
  - `NLogin.fromNsec` / `fromBunker` / `fromExtension`
    (`src/hooks/useLoginActions.ts`).
  - TanStack `useAuthor` (kind 0, memory only).
  - `useNostrPublish` adds a client tag.
  - One `NPool` with a fixed relay list and no NIP-65.
  - `useLoginActions.ts` and `useCurrentUser.ts` are **byte-identical in 6
    repos**: blobbi-bloom, blobbi-go, blobbi-island, blobbi-island-sky,
    echos-of-the-wood, nostr-farm. The DM provider is copied 3 times.
- **ditto (most complete).**
  - Login: nostrconnect (`NLogin.fromNostrConnect`) and NIP-55
    (`src/lib/androidNativeSigner.ts`), with secure storage.
  - Relays: NIP-42 `AuthAwareRelay`, outbox model (`src/lib/outbox.ts`),
    relay health, IndexedDB profile cache.
  - Renders Armada game invite links (`src/lib/armadaInvite.ts`).
- **nostr-pet (Blobbi).**
  - nostrconnect login (`generateNostrConnectURI(..., {name:'Blobbi'})`).
  - **Framework-free** helpers: `src/lib/home-pool.ts`,
    `relay-routing.ts`, `relay-health.ts`, `features/onboarding/new-account.ts`.
  - `usePublishAdapter.ts` checks that the signer's pubkey matches and
    times out after 8 s.
  - Relays: relay.ditto.pub, relay.primal.net, relay.nostr.band.
- **blobbi-island (realtime social over relays).**
  - Presence `31950`: addressable per session, NIP-40 expiration about
    35 s, with a heartbeat.
  - Ephemeral `21201` chat bubbles.
  - The event registry is in `src/protocol/event-registry.ts` + `NIP.md`.
- **anagram** (`lnbits-work/anagram`). Full NIP-17/44/59 messaging.
  **Call invites are kind `21117` rumors inside NIP-59 gift wraps**
  (invite, ringing, accept, end). Media goes over Iroh, never Nostr. This
  is the best template for a "challenge a friend" handshake.
- **armada.**
  - Invite bundle `33301`: an naddr plus a secret in the URL `#fragment`.
  - Ephemeral gift wrap `21059` carrying typing rumors.
  - NIP-29 groups.
  - NIP-55 via a Capacitor plugin.
- **Blobbi conventions** (`@blobbi-kit/core`).
  - `31124` pet state.
  - `11125` Blobbonaut profile, with `current_companion`.
  - Namespace tag `["b","blobbi:ecosystem:v1"]`.
  - `@nostr-games/inventory` is already a shared, dependency-free protocol
    package (31632/31633/31634/1416/1417). **A player's 3D Blobbi can be
    resolved from their pubkey:** 11125 `current_companion`, then 31124,
    then the identity seed.
- **Kind numbers already used in the ecosystem; avoid them:** 31950,
  21201, 31951, 21951, 14919, 3367, 16769, 36767, 31417, 31415, 31416,
  33301, 21117, 8211.
- **Lesson from all of them.** None sends game state over Nostr.
  Realtime goes over LiveKit (armada), Iroh (anagram) or relays only for
  social state. That matches the rule above.

---

## 3. Nostr standards to use

Read from upstream nips master `a79e21d` (2026-10-05). The local clone
`~/Developer/nips` is from January 2026 and stale.

| Need | Standard | Notes |
| --- | --- | --- |
| Profile | [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) kind 0, [NIP-24](https://github.com/nostr-protocol/nips/blob/master/24.md) fields | `display_name`, `name`, `picture`, `nip05`, `lud16`, `bot` |
| Verified name | [NIP-05](https://github.com/nostr-protocol/nips/blob/master/05.md) | Also usable for server identity: `_@rumble.blobbi.pet` |
| Encodings / links | [NIP-19](https://github.com/nostr-protocol/nips/blob/master/19.md), [NIP-21](https://github.com/nostr-protocol/nips/blob/master/21.md) | npub, nprofile, naddr; `nostr:` only as a secondary link |
| Friends | [NIP-02](https://github.com/nostr-protocol/nips/blob/master/02.md) kind 3 | Read only. Friends = mutual follows. Never write kind 3 |
| Relay lists | [NIP-65](https://github.com/nostr-protocol/nips/blob/master/65.md) kind 10002; [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) kind 10050 | Outbox for profiles; DM inbox for invites |
| Signing | [NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md), [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md) | bunker:// and nostrconnect:// (secret required; `switch_relays`) |
| Private invites | [NIP-17](https://github.com/nostr-protocol/nips/blob/master/17.md) + [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) + [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) | kind 14 rumor in kind 13 seal in kind 1059 wrap |
| Live private signals | NIP-59 **kind 21059** ephemeral gift wrap | Merged 2026-05 ([#2245](https://github.com/nostr-protocol/nips/pull/2245)); names real-time gaming as a use case |
| Expiry | [NIP-40](https://github.com/nostr-protocol/nips/blob/master/40.md) | Relays MAY ignore it, so **clients must filter expired events themselves** |
| Player proves pubkey to server | [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) shape (kind 22242, challenge + exact URL) | Reused as a model over our WebSocket; [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) is the HTTP equivalent |
| "Open with Rumble" | [NIP-89](https://github.com/nostr-protocol/nips/blob/master/89.md) kind 31990 | Only once we have our own kind (M8D) |
| Optional "playing now" | [NIP-38](https://github.com/nostr-protocol/nips/blob/master/38.md) kind 30315 + expiration | Opt-in only; public |
| Room shape to borrow | [NIP-53](https://github.com/nostr-protocol/nips/blob/master/53.md) 30311/30312 | Borrow tag shapes; don't publish 30312 (it renders as an audio room) |

**Don't use these:**
- NIP-78 (30078): now AUTH-gated and owner-private, so wrong for public
  announcements.
- NIP-90 DVMs: now marked unrecommended.
- NIP-28: unrecommended.
- NIP-29: wrong for ephemeral lobbies, though possibly right for clans
  later.

No game, lobby, match or tournament NIP exists, merged or open. Closest
precedents:
- [NIP-64](https://github.com/nostr-protocol/nips/blob/master/64.md) chess records.
- NIP-AC call signalling, rumors inside 21059
  ([#2301](https://github.com/nostr-protocol/nips/pull/2301),
  [#2461](https://github.com/nostr-protocol/nips/pull/2461), open,
  implemented in Amethyst).

---

## 4. Libraries evaluated

Gzipped sizes were measured by bundling only the pieces a game would use
(pool, NIP-07/46 and local signers, NIP-44/59) with esbuild.

| Library | Version (date) | gz | Verdict |
| --- | --- | --- | --- |
| **[nostr-tools](https://github.com/nbd-wtf/nostr-tools)** | 2.25.2 (2026-09) | **~36 KB** | **Chosen.** No framework, only @noble/@scure. Pool with reconnect, ping and NIP-42. `BunkerSigner` covers both NIP-46 directions and `auth_url`. Ships nip44/nip59/nip17. Every one of our apps already depends on it. No outbox router or profile cache, which we write. |
| [applesauce](https://github.com/hzrd149/applesauce) | 6.2.x (2026-09/10) | ~79–86 KB | **Runner-up.** Best NIP-46 permissions API, `AccountManager`, Amber helpers; very active (noStrudel). Costs RxJS and pins nostr-tools ~2.19, so it would be duplicated. |
| [@nostrify/nostrify](https://github.com/soapbox-pub/nostrify) | 0.55.1 | ~135 KB | What our React apps use. Too heavy for the game (zod is 442 KB minified); `NConnectSigner` is bunker-only; Deno/JSR-first. |
| [NDK](https://github.com/nostr-dev-kit/ndk) | 3.0.3 (2026-02) | ~111 KB | Slowing; odd dependencies (shiki, sandpack); duplicate @noble v1 and v2. |
| [welshman](https://github.com/coracle-social/welshman) | 0.13.0 | ~156 KB | Best relay routing, but `@welshman/app` is Svelte-coupled, pre-1.0 and churning. Read its router for ideas. |
| [@snort/system](https://github.com/v0l/snort) | 2.1.9 | ~65 KB | Capable (outbox, NIP-46, NIP-55) but shaped around Snort. |
| [rx-nostr](https://github.com/penpenpng/rx-nostr) | 3.7.8 | ~16 KB (no crypto) | No NIP-46; its crypto companion is deprecated. |
| [nostr-login](https://github.com/nostrband/nostr-login) | 1.7.12 (2025) | — | Stale (nostr-tools 1.x, NDK 2.x). |
| [window.nostr.js](https://github.com/fiatjaf/window.nostr.js) | 0.8.1 | — | A drop-in NIP-46 widget behind `window.nostr`. Fine as a shortcut, but gives up control of the UX; npm install via JSR alias 404'd. |

**Recommendation:**
- nostr-tools 2.25.x, plus about 300 lines of our own code:
  - a signer interface,
  - a capped relay selector,
  - a kind 0 / 10002 cache (memory LRU + IndexedDB, batched lookups).
- Revisit applesauce only if multi-account management or NIP-55 becomes a
  requirement.

---

## 5. Signer model

**Players never paste an nsec into Rumble.** Methods, in order:

1. **NIP-07 extension.** Desktop; instant. Alby, nos2x and Bark (which
   proxies to a NIP-46 bunker) are maintained.
   - Poll briefly for `window.nostr`, which is injected after load.
   - Feature-detect `window.nostr.nip44`.
2. **NIP-46 nostrconnect:// (QR + deep link).** The main path on mobile:
   - Amber and Primal on Android;
   - Aegis and Clave on iOS (TestFlight);
   - nsec.app (beta, occasional hangs).
3. **NIP-46 bunker:// paste.** The same code path.
4. **Guest.** No Nostr. Exactly what Rumble is today.

**Not now:**
- A local generated key. If ever: generate, show a NIP-49 export, never
  import. Better to link to a proper onboarding (nostr-pet already has
  one).
- Direct NIP-55, which needs a native wrapper (Capacitor).

The interface is ours: tiny, and shaped like nostr-tools' own signers, so
`window.nostr` and `BunkerSigner` satisfy it with almost no wrapping.

```ts
interface RumbleSigner {
  readonly method: 'nip07' | 'nip46';
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<NostrEvent>;
  nip44?: { encrypt(pk: string, text: string): Promise<string>; decrypt(pk: string, data: string): Promise<string> };
}
```

**Rules:**
- **Persistence.** Store `{method, pubkey, bunkerUrl?, clientSecret?}`
  (Jumble and Primal pattern), so a reload doesn't re-pair. Never a user
  secret key.
- **Never sign on the gameplay path.** Sign at login (server auth), when
  sending an invite, and nowhere else. A remote sign takes seconds, or
  never if the phone sleeps. Every call gets a timeout and a "check your
  signer" message.
- **Ask for permissions up front, and only these:**
  `sign_event:22242,sign_event:13,nip44_encrypt,nip44_decrypt`. Never ask
  to sign kind 0, 3 or 10002.
- **Popups.** `auth_url` popups only from a click; show a link as a
  fallback.
- **NIP-46 relays.** Use `wss://relay.nsec.app` plus one fallback, and
  honour `switch_relays`.
- **Missing nip44.** If the signer has no nip44, private invites are
  disabled with an explanation, and login still works.

---

## 6. Profile strategy

- **Display name.** `display_name`, then `name`, then a short npub
  (`npub1abcd…wxyz`).
  - Nameplates: 24 characters, set via `textContent` only.
  - Strip control and bidi characters.
- **Avatar.** `picture`, only `https:`, loaded with
  `referrerpolicy="no-referrer"` and CSS-capped. Fallback: the player's
  Blobbi or an identicon.
  - Loading third-party avatars reveals the viewer's IP to that host.
    Acceptable for a casual game; note it in privacy (§15).
- **NIP-05.** Verified lazily: fetch `/.well-known/nostr.json` with
  CORS and a timeout. Show it only when it matches; never block on it.
- **Blobbi tie-in (Rumble-specific, later).** 11125 `current_companion`,
  then 31124, then the kit's identity seed, gives the fighter's
  appearance. Players without one get a seed derived from their pubkey.
- **Cache.**
  - Memory LRU + IndexedDB keyed by pubkey.
  - The newest `created_at` wins.
  - Stale-while-revalidate after about 1 h.
  - Batch lookups: one REQ with many `authors` per relay.
- **No metadata?** The player still plays, shown as a short npub with a
  pubkey-derived look.
- **Who resolves profiles.** Clients do, from the **pubkey**. The server
  never sends names: it only vouches for "slot P2 is pubkey X". No custom
  Rumble profile event.

---

## 7. Relay strategy

Bounded and predictable. **At most 8 open relay sockets.** Idle sockets
close after about 30 s. While a round is being played, only the invite
inbox subscription stays open.

| Purpose | Relays |
| --- | --- |
| Bootstrap / index (find 10002, 10050, kind 0) | A fixed set of 3, e.g. `wss://purplepag.es`, `wss://relay.primal.net`, `wss://relay.ditto.pub` (verify when implementing) |
| A user's profile | Their NIP-65 **write** relays, **max 3**, plus the bootstrap set |
| Sending a private invite | The recipient's **10050** relays (max 3), plus a self-copy to our own 10050 |
| Reading my invites | My 10050 (max 3), with NIP-42 AUTH (relays serve 1059 only to the recipient) |
| NIP-46 | `wss://relay.nsec.app` + 1, or whatever the signer's `switch_relays` names |
| Public announcements (M8D) | 2–3 fixed relays published in the client build, which clients also read |

Further rules:

- **User relay lists.** Respect them, capped. Never fan out to every
  relay a user lists.
- **Validation.** Every event is verified (`SimplePool` verifies), then
  checked for the expected kind, author and `d` tag, expiration, size,
  and `created_at` sanity.
- **Publish quorum** (Jumble's rule). Done at `min(ceil(n/3), 2)` acks,
  with a timeout.
- **Recipient has no 10050.** NIP-17 says don't DM them. Fall back to
  "copy invite link".

---

## 8. Presence findings

**No general presence NIP exists, and no open PR for one either.**

What exists:
- **NIP-38** kind 30315 (`d:"general"`, `r` link, `expiration`). Public,
  rendered by Damus, Amethyst and noStrudel. Little used.
- **NIP-53** 10312 room presence, tied to 30312 audio rooms.
- **Ephemeral kinds** (20000–29999), never stored.
- **blobbi-island's** addressable heartbeat with expiration (31950).

**Recommendation:**
- Presence that matters ("who is in my room, on my server") is a **game
  server fact** and already exists in the protocol.
- Social presence on Nostr is **deferred**. If wanted:
  - an opt-in NIP-38 status, "Playing Blobbi Rumble", with a link and a
    5-minute expiration refreshed every ~2 minutes while in a lobby; or
  - for friends only, private `21059` pings (not stored).
- No new presence kind; no stored online/offline history.

---

## 9. Private invite strategy (NIP-17)

**Use NIP-17 as written.** The rumor is a normal **kind 14** chat message
that any NIP-17 client shows as a readable DM. Rumble parses its tags for
one-tap join. No custom encryption, no custom kind for the invite itself.
- A custom rumor kind would be invisible in other DM clients.
- An invite showing up in the friend's normal DM history is a feature.

```
rumor kind 14, pubkey = inviter
content: "Join my Blobbi Rumble game: https://rumble.blobbi.pet/join#s=wss%3A%2F%2Frumble.blobbi.pet%2Fws&r=A7F2&t=<ticket>"
tags:
  ["p", <invitee>]
  ["subject", "Blobbi Rumble invite"]
  ["r", "wss://rumble.blobbi.pet/ws"]            the authoritative server
  ["rumble", "room", "A7F2"]                    room id on that server
  ["rumble", "server", <server pubkey hex>]     optional; checked against the server itself (§11)
  ["rumble", "mode", "casual"]
  ["expiration", <now + 30 min>]
→ seal kind 13 (signed by the inviter; tags empty) → wrap kind 1059 (random key, ["p", invitee], expiration)
   sent to the invitee's 10050 + a self-copy
```

- **Ticket.** Server-issued, short-lived and single-room. It gets you a
  *seat* in that room and nothing else.
  - It goes in the URL **fragment**, so it never reaches server logs or
    `Referer`.
  - Possession of the link must not grant more than a seat.
- **Accept / decline / "on my way".** Optional, as **21059** ephemeral
  gift wraps with a small app rumor kind (the anagram 21117 and NIP-AC
  pattern). That is the only place a custom kind may be justified, and
  only in M8C when needed.
- **Spam.** Invites from people the player follows (kind 3) show up
  immediately. Others go to a "requests" list.
- **Two signatures per recipient** (the seal by the user, the wrap by an
  ephemeral key). A remote signer may prompt per invite, so invites are
  sent one at a time, on a click.

---

## 10. Public discovery strategy (later, M8D)

- **No existing kind fits.** 30311 makes clients try to play a stream;
  30312 renders as an audio room.
- **Proposal.** One custom **addressable** kind in the 3xxxx range (number
  chosen in M8D after a collision check), **signed by the server's key,
  not the player's**:
  - `d` = room id;
  - `status` open / playing / ended;
  - `["r", "wss://…/ws"]`;
  - `players` 2/4;
  - `mode`;
  - `title`;
  - `t` tags;
  - `alt` (NIP-31 readable fallback);
  - `expiration` = now + 2–5 min, refreshed while the room is open.
- **Old games disappear.** Because the event is addressable it replaces
  itself; it also expires, and clients drop anything expired or older than
  2× the refresh interval even if a relay keeps it.
- **Cheap.** About one event per open room per refresh interval, only for
  rooms explicitly marked public.
- **Clients never trust metadata blindly.**
  - The announcement must bind to its endpoint (§11), or it is shown as
    an unverified server.
  - Player counts are hints; joining asks the server.
  - Limit how many announcements are shown per author.
- **Never by default for participant-hosted servers:** it publishes a
  home IP or hostname (§15).

---

## 11. Server identity and discovery

A server **optionally** has its own Nostr keypair. It lives in an env file
or secret store; never committed.

- **Binding a key to an endpoint.** Domain control is the proof.
  `https://<host>/.well-known/rumble.json` returns
  `{ pubkey, name, operator?, ws: "/ws", version }`. Optionally, NIP-05
  `_@<host>` in `/.well-known/nostr.json` names the same key.
  - A signed announcement or invite claiming server key K at host H is
    **verified** only if H's well-known file says K. TLS already
    authenticates H.
  - This works for tunnels too: a trycloudflare host serves its own
    well-known file.
- **Trust labels in the client:**
  - **Official:** key in a built-in allowlist.
  - **Community:** verified key + operator npub. Later this could be
    "operated by someone you follow".
  - **Unknown:** no key, or a mismatch. Allowed, with a clear "you are
    trusting this host" notice.
  - This is not a PKI. If an endorsement list is ever needed, the
    official npub signs a list of server pubkeys.
- **Server announcements on Nostr** ("server X in region Y, capacity Z"):
  *useful later* for community discovery. **Premature now**: the official
  server plus invite links cover every current need, and announcing
  community endpoints publicly invites scanning and DoS. Revisit after
  rooms and public games exist. NIP-66 (30166, relay discovery signed by
  monitors) and NIP-89 handler announcements are the patterns to copy.
- **The server signs facts it is authoritative for** (future: room
  created, match result). Nostr only relays the signature.

---

## 12. Hosted vs player-hosted: one model

The receiving client needs exactly four things, whoever hosts:

| Field | Example (hosted) | Example (participant-hosted) |
| --- | --- | --- |
| where: authoritative server | `wss://rumble.blobbi.pet/ws` | `wss://quiet-fox.trycloudflare.com/ws` |
| which room | `A7F2` | `B91C` (or the default room) |
| who invited me | inviter pubkey (from the seal) | same |
| what: game / mode | `blobbi-rumble`, `casual` | same |

Plus optional fields, verified by the client and never trusted from the
invite text:
- the server pubkey, checked via §11;
- a join ticket.

**The abstraction is sound.** A room is `(server endpoint, room id)`,
optionally anchored by the server pubkey. No global room database, so
invitations from independent servers coexist naturally. The only
difference the client shows is the trust label from §11, not the
physical hosting.

**Join link.**
`https://rumble.blobbi.pet/join#s=<ws url>&r=<room>&t=<ticket>`. This is
the `?server` override we already have, plus a room. The `nostr:naddr`
form is only for public rooms, as a secondary link. **No custom URI
scheme:** a browser game gains nothing from it.

---

## 13. Player hosting and WebRTC findings

**What hosting needs today:** `npm run serve` + an HTTPS tunnel
(cloudflared, Tailscale Funnel, ngrok) or a port-forward / reverse proxy,
or a VPS. It works; it is technical.

**Paths to "Host Game" without that work:**

1. **A room on the official server (the default).** "Host Game" means
   *create a room*, not *run infrastructure*. One click, our
   infrastructure, and the trust label is official. Needs M8B rooms. This
   gives ordinary players the experience they actually want.
2. **A desktop host app.** A packaged Node server plus an automatic quick
   tunnel (e.g. a cloudflared quick tunnel). The same authoritative code;
   nearly one-click; the tunnel hides the host's IP. Could live next to
   blobbi-desktop.
3. **Outbound rendezvous.** The host's server dials *out* to
   `wss://rumble.blobbi.pet/host`, which forwards player sockets to it (a
   TURN for WebSockets).
   - No NAT or port issues, no tunnel tool, and the host's IP stays
     hidden.
   - We pay bandwidth (state traffic for each player); the host stays
     authoritative.
4. **Auto-provisioned temporary servers** (Fly Machines, Edgegap and the
   like). Really "official hosting with regions"; a cost decision, not an
   architecture change.

**WebRTC (host browser runs the match, peers over DataChannels).**

| | Node authoritative (today) | Browser host + WebRTC |
| --- | --- | --- |
| Can the sim run there? | yes | **yes**: `client/local.ts` already runs the whole match in a page; `RumbleHost` has no transport |
| NAT | the server is reachable by definition | ICE/STUN usually works; a meaningful minority of pairs needs **TURN**, which we would have to run and pay for anyway |
| Signalling | none | needed (our server, or Nostr 21059 à la NIP-AC) |
| Lifecycle | process stays up | **a hidden or backgrounded host tab is throttled** (timers, rAF); a closed lid or a phone call ends the match for everyone |
| Host migration | n/a (a crash restarts) | hard (state transfer, slot re-binding); without it the host leaving ends the match |
| Latency | everyone pays the RTT to the server | the host gets 0 ms (unfair); peers pay the RTT to the host's home uplink |
| Cheating | operator trusted | host trusted (same as a participant-hosted Node), with an easier-to-tamper runtime (devtools) |
| Determinism | not needed (authoritative) | not needed either (still authoritative, not lockstep) |
| Deployment | a process + TLS | static page + STUN/TURN + signalling |
| Future sats | a neutral server is possible | **never neutral**: the host is a competitor |

**Recommendation: don't adopt WebRTC.** It removes the "run a server"
step but adds TURN, signalling, tab-lifecycle fragility and an unfair
host advantage. It also can never serve value-bearing matches.

Make player hosting easy with path 1 (official rooms) first, then 2 or 3
if community hosting is wanted. Keep `RumbleHost` free of transport so
that a WebRTC experiment stays *possible*. Player-hosted authoritative
matches can become one-click-ish (path 2 or 3) **without** giving up the
server-authority model.

---

## 14. Trust model

| Case | Who is trusted | What must exist |
| --- | --- | --- |
| **A. Casual, official server** | Blobbi (operator) | Official server key in the client allowlist; rooms on it |
| **B. Casual, player-hosted** | The host, knowingly | The trust label ("hosted by <npub> at <host>"); the player clicks Join |
| **C. Future value-bearing** | Nobody who competes | A **neutral** server (official, or an operator who is not a participant), results **signed by the server key**, stakes escrowed outside any player's control |

**Architecture to put in place now, so C stays possible:**

- **Room metadata records** `trust: 'casual'`, the server pubkey and the
  creator pubkey. A value-bearing mode later requires
  `operator ∉ participants` and an allowlisted or neutral server key.
  Nothing today may *assume* casual.
- **Player identity is proven to the server** (M8A auth). A result can
  only be attributed to a pubkey that proved itself.
- **Results are server facts.** If published at all, they are signed by
  the server key. Never self-reported, never inferred from Nostr events.
- **Not now:** anti-cheat, replays and escrow. When the time comes, the
  pointers are Cashu P2PK (NIP-60/61); there is no accepted
  escrow/arbiter NIP.

---

## 15. Security and privacy

- **IP addresses.**
  - Every server operator sees players' IPs. The join screen says who
    runs the server.
  - A participant-hosted server on a port-forward exposes the host's home
    IP to every player. Tunnels and rendezvous hide it.
  - Never publish participant-hosted endpoints publicly by default.
- **Invite and join URLs are untrusted input.**
  - Only `wss:` (or `ws:` for a page served over `http:` on a LAN), no
    userinfo, length cap.
  - Room ids `[A-Za-z0-9]{4,16}`.
  - Show the host prominently; unknown servers need an explicit click.
    **Never auto-connect from a link.**
  - Never navigate to URLs taken from event content.
  - The ticket rides in the fragment.
- **Events are untrusted input.**
  - Verify the signature, then kind, author, `d`, expiration, size and
    `created_at`.
  - For gift wraps: seal pubkey must equal rumor pubkey (NIP-17 MUST).
  - Ignore unknown tags.
  - Render profile text with `textContent` only.
  - Cap counts per author.
- **Malicious announcements** (M8D) are only "verified" via the
  well-known binding. Counts are hints; the server answers on join.
- **Server auth.**
  - The challenge is server-issued, single-use, and expires in about
    60 s.
  - The signed event names the **exact** WebSocket URL, and the server
    checks it. A malicious server therefore can't replay a player's
    proof to another server or relay.
  - **Clients never accept a name from the server**; they resolve the
    pubkey themselves.
- **Signer permissions.** Minimal (§5); never kind 0, 3 or 10002; never
  during gameplay.
- **Metadata leakage.**
  - NIP-17 hides content and sender from relays, but the wrap reveals the
    recipient and an approximate time.
  - NIP-38 statuses are public, so opt-in only.
  - Loading avatars leaks the viewer's IP to image hosts.
- **Nostr is not authority (the rule at the top).** No Nostr event changes game state,
  slots, scores or power. The server ignores Nostr entirely except to
  verify a player's auth event.

---

## 16. Proposed M8 milestones

Each one is small and independently shippable. Guests keep working
throughout.

**M8A: Nostr identity and profile** (no rooms, no publishing).
1. *Client.*
   - Add `nostr-tools`.
   - `src/social/` (no Rumble imports, so it can be extracted later):
     the `RumbleSigner` adapters (NIP-07, NIP-46 nostrconnect QR and
     bunker), persisted login, a capped relay pool, and a kind 0 / 10002
     loader with a cache.
   - A small login card: Connect Nostr / Play as guest, then my avatar
     and name.
2. *Server auth* (protocol addition, backwards compatible).
   - `welcome` gains `challenge`.
   - The client may answer `{t:'auth', event}` (kind 22242, tags
     `challenge` and `relay` = the exact ws URL).
   - The server verifies signature, kind, URL, challenge and freshness,
     then binds the pubkey to the connection and its slot.
   - A new low-rate `roster` message `{P1: pubkey|null, …}` goes out on
     change.
   - Unauthenticated connections play as guests exactly as now.
   - Server dependency: nostr-tools' pure verify only. No relay
     connections from the server.
3. *Display.* Other players' nameplates and avatars, resolved by clients
   from roster pubkeys; guests are shown as P1..P4.
4. *Tests.* Signer adapters mocked; auth accept and reject (wrong URL,
   stale, replayed, bad signature); roster updates; cache behaviour;
   text sanitising.

Optional at the end of M8A: the player's Blobbi from 11125/31124 as the
fighter's look.

**M8B: rooms and server identity.**
- `RoomManager` between `server.ts` and `RumbleHost`.
- `{t:'join', room, ticket?}`; the default room for old clients.
- Room lifecycle: created, empty for N seconds, then reaped.
- Per-room limits plus the global cap.
- Room metadata: mode, visibility, creator pubkey, `trust:'casual'`.
- Create-room over the authenticated socket; short-lived tickets.
- The server keypair (env) + `/.well-known/rumble.json`.
- Client `?room=` and `/join#…` handling, with the server trust label.

**M8C: private invites.**
- NIP-17 kind 14 invites with Rumble tags (§9), sent to 10050.
- The inbox listens on my 10050 with AUTH; invites from follows are
  surfaced.
- An invite card leads to the server-trust notice, then Join.
- "Copy link" fallback when there is no 10050 or no nip44.
- Accept/decline pings via 21059 only if playtests want them.

**M8D: public games** (only if justified by then).
- A server-signed addressable room announcement with expiration (§10).
- A NIP-89 handler for that kind.
- A public games list, verified via well-known.
- Optional NIP-38 "playing" status.
- Server-directory announcements stay out until community hosting
  exists.

**Different from the suggested split.** Server identity moves into M8B,
because invites (M8C) need to show *whose* server they point at. Auth to
the game server lands in M8A, because "the server knows who holds P2" is
what makes Nostr identity visible in-game at all. Presence is dropped as
a milestone: it is server-side today and optional NIP-38 later.

---

## 17. Things we should NOT build ourselves

- **Crypto:** NIP-44, NIP-59 wrapping, signature verification. Use
  nostr-tools.
- **The NIP-46 protocol client** (`BunkerSigner`), and any key storage or
  "paste your nsec" flow.
- **A DM system, a relay, or a NIP-29 group server** for lobbies.
- **A presence protocol, an invite encryption scheme, or a URI scheme.**
- **Room transport over Nostr, gameplay over WebRTC, or any per-frame
  Nostr traffic.**
- **A server PKI.** Domain-bound well-known files plus an allowlist are
  enough.
- **Escrow or anti-cheat** before value-bearing matches are actually
  designed.

### Shared library boundary (recommendation; don't extract yet)

| Generic: belongs in a shared, framework-free package (e.g. `@blobbi-kit/nostr` or beside `@nostr-games/inventory`) | Rumble-specific: stays in Rumble |
| --- | --- |
| Signer adapters + login persistence (NIP-07, NIP-46 both directions, timeouts, permission sets) | The invite payload and its tags |
| A capped relay pool / selection (bootstrap, outbox, 10050) | Room ids, tickets, the join link format |
| Profile + relay-list loader and cache, display-name and avatar sanitising | The room announcement kind (M8D) |
| NIP-17 send/receive helpers | `/.well-known/rumble.json`, the server auth handshake |
| Event and URL validation helpers | The roster protocol, trust labels, presence policy |
| Blobbi-from-pubkey resolution (11125, then 31124) | |

Six of our apps carry identical copies of the login code today. The
shared core should sit on **nostr-tools** (which they already all depend
on), with thin React hooks on top for the MKStack apps. Rumble's
`src/social/` is written against that boundary, so extraction later is a
move, not a rewrite.

---

## References

**NIPs:** https://github.com/nostr-protocol/nips (master `a79e21d`, 2026-10-05). The ones cited: 01, 02, 05, 07, 11, 17, 19, 21, 24, 29, 38, 40, 42, 44, 46, 51, 53, 59, 64, 65, 66, 78, 89, 90, 98.

**PRs:**
- NIP-59 kind 21059: [#2245](https://github.com/nostr-protocol/nips/pull/2245)
- NIP-AC calls: [#2301](https://github.com/nostr-protocol/nips/pull/2301)
- WebRTC signalling: [#2461](https://github.com/nostr-protocol/nips/pull/2461)
- Escrow (open, unaccepted): [#1714](https://github.com/nostr-protocol/nips/pull/1714), [#2323](https://github.com/nostr-protocol/nips/pull/2323)

**Libraries:** nostr-tools https://github.com/nbd-wtf/nostr-tools ·
applesauce https://github.com/hzrd149/applesauce · nostrify
https://github.com/soapbox-pub/nostrify · NDK
https://github.com/nostr-dev-kit/ndk · welshman
https://github.com/coracle-social/welshman · snort
https://github.com/v0l/snort · rx-nostr
https://github.com/penpenpng/rx-nostr · nostr-login
https://github.com/nostrband/nostr-login · window.nostr.js
https://github.com/fiatjaf/window.nostr.js

**Clients studied:**
- **Jumble** (nostr-tools, one signer class per method:
  `src/providers/NostrProvider/*.signer.ts`; 5-relay cap and publish
  quorum in `src/services/client.service.ts`):
  https://github.com/CodyTseng/jumble
- **noStrudel** (applesauce `AccountManager`, `src/services/accounts.ts`):
  https://github.com/hzrd149/nostrudel
- **Coracle / Flotilla** (welshman router; fetch relays and profile right
  after login): https://github.com/coracle-social/coracle,
  https://github.com/coracle-social/flotilla
- **Primal web** (persistent NIP-46 client keypair + timeouts,
  `src/lib/PrimalNip46.ts`): https://github.com/PrimalHQ/primal-web-app
- **Amethyst** (NIP-55, NIP-AC calls):
  https://github.com/vitorpamplona/amethyst
- **Chess experiments:**
  - Jester: https://github.com/jesterui/jesterui
  - tkhumush/Chess: https://github.com/tkhumush/Chess
  - Lessons on relay lobbies: https://stacker.news/items/382585

**Signers:**
- Amber: https://github.com/greenart7c3/Amber
- noauth / nsec.app: https://github.com/nostrband/noauth
- nsecbunkerd: https://github.com/kind-0/nsecbunkerd
- Aegis: https://github.com/ZharlieW/Aegis
- Clave: https://github.com/DocNR/clave
- Bark: https://github.com/forgesworn/bark
- Alby: https://github.com/getAlby/lightning-browser-extension
- nos2x: https://github.com/fiatjaf/nos2x

**Our code (local):**
- `~/Developer/ditto` (`src/lib/outbox.ts`, `AppPool.ts`,
  `androidNativeSigner.ts`, `armadaInvite.ts`)
- `~/Developer/nostr-pet` (`src/lib/home-pool.ts`, `relay-health.ts`,
  `useLoginActions.ts`)
- `~/Developer/blobbi-island` (`src/protocol/event-registry.ts`,
  `useIslandPresence.ts`)
- `~/Developer/lnbits-work/anagram` (`nips/iroh-calls.md`, `src/lib/nostr/`)
- `~/Developer/armada/NIP.md`
- `~/Developer/mkstack` (`src/hooks/useLoginActions.ts`,
  `NostrProvider.tsx`)

---

## M8A as built (2026-10-09)

What was implemented, and where it differs from the plan above.

- **Library:** nostr-tools 2.25.2 only (`pure`, `nip19`, `nip42`, `pool`,
  `utils`, types from `nip07` and `signer`). It adds about 25 KB gzipped
  to the game bundle.
- **`src/social/`:** signer, auth, profile, directory, pool, relays,
  login, keys, avatar. It imports only nostr-tools and itself, and a test
  enforces that. The Rumble glue is `client/identity.ts` and
  `client/identityView.ts`, plus the handshake in `net/server.ts` and the
  roster in `net/host.ts`.
- **Signer:** `NostrSigner` = nostr-tools' `Signer` + `method`.
  - NIP-07 only.
  - Detection polls for 1.5 s, because extensions inject late.
  - Every call has a 60 s timeout.
  - Errors are classified as unavailable, denied, timeout, malformed or
    failed.
  - Returned keys and events are checked: the event must verify, be by
    the key the extension gave, and be exactly the template.
- **NIP-46: deferred to M8A.1.**
  - nostr-tools' `BunkerSigner` needs a local *client* keypair for the
    NIP-46 session. A reload without re-pairing means persisting that
    session key. It isn't the user's key, but M8A's rule was no secret
    key in storage, so the trade-off is the user's to decide.
  - The rest is UI and session work, not protocol: a QR code (a new
    dependency or a small encoder), `auth_url` popups from a click,
    `switch_relays`, a "check your phone" state, and the NIP-46 relay
    choice (`wss://relay.nsec.app` + 1).
  - The interface already fits `BunkerSigner` unchanged.
- **Auth:** kind 22242 via nostr-tools `makeAuthEvent`, verified with
  `verifyEvent` on a fresh copy of the event.
  - Challenge: 32 random bytes, valid 120 s, one use, one per connection,
    at most 1 per second, at most `2 × maxConnections` outstanding.
    Consumed or expired challenges are deleted.
  - `created_at` must be within ±300 s of the server clock. The challenge
    expiry is what makes a proof short-lived; this window only tolerates
    players' clock drift.
  - The proof's address is compared as host[:port]/path without the
    scheme, because TLS ends at a proxy.
  - Expected address: `PUBLIC_URL`. Unset, the Host header of that
    connection (documented as weaker).
- **Protocol:** all additions are optional.
  - Client to server: `challenge`, `auth`, `logout`.
  - Server to client: `challenge`, `auth`, `roster`, and
    `welcome.features: ['nostr-auth']`.
  - The roster goes out on change and is never droppable. It holds only
    `{who: bot | guest | nostr, pubkey}`. State messages are unchanged.
- **Relays:**
  - Lookup set: `purplepag.es`, `relay.damus.io`, `relay.ditto.pub`.
    The plan named relay.primal.net, but it returned no kind 0 or 10002
    for any lookup during testing.
  - At most 3 write relays per user, at most 8 open relays, idle ones
    closed after 30 s.
  - No relay connection until there is a pubkey to look up, so a guest
    page with only guests opens none.
- **Profiles:**
  - `display_name` (or the legacy `displayName`), then `name`, then a
    short npub.
  - Content over 16 KB is not parsed; fields are capped at 48 code points.
  - Control, bidi, zero-width and line-separator characters are stripped,
    and piles of combining marks are cut.
  - Pictures: https only, no credentials, at most 1024 characters, loaded
    with no referrer, falling back to a deterministic identicon.
  - Cache: memory + localStorage. 64 entries; fresh for 30 min; a missing
    profile is retried after 60 s; nothing older than 24 h is kept.
  - Stored entries are re-cleaned when loaded.
- **NIP-05:** parsed, not shown. Unverified it would mislead, and
  verifying means fetching arbitrary domains. Left for later.
- **UI:**
  - An identity card under the connection pill.
  - A first-visit welcome card that never blocks: the player is already
    in as a guest.
  - A player list (P1 Daniel · P2 Guest · P3 Bot).
  - Fighter name tags (canvas text, 14 characters).
  - A NOSTR line in F4.
  - Local mode has no identity at all.
- **Reconnects:** the server forgets the identity with the connection.
  If the user connected in this page, the client proves it again
  automatically on the new connection. After a reload it only offers
  "Continue as …", since signing on page load is not allowed.

---

## M8B as built (2026-10-09)

- **Auth audit.** The signed kind-22242 proof has exactly one path:
  `IdentitySession → send → ws.send` to the game server, which verifies
  it locally. The relay pool can only `querySync` (reads) and `close`.
  Nothing in the app calls `publish`, and `SimplePool` is created without
  `automaticallyAuth`, so it cannot sign a relay's AUTH challenge either.
  `social/boundary.test.ts` enforces all of this.
- **Rooms.** `net/rooms.ts`: `RoomManager` sits between `server.ts` (the
  sockets) and `RumbleHost` (one per room), as planned in §1.
  - **Routing differs from the plan.** It uses the WebSocket URL's query
    (`/ws`, `/ws?room=A7F2`, `/ws?create=1`) rather than a first `join`
    message. The welcome stays immediate, old clients land in the open
    room unchanged, and the auth binding ignores the query (host + path
    only).
  - Room ids: 4 characters from a 31-character alphabet with no
    look-alikes (`net/roomId.ts`). The open room's id is `OPEN`, which no
    generated code can be.
  - Lifecycle: the open room is permanent. A private room is kept for
    120 s after its last connection leaves, then disposed (match, Havok
    world, timers).
  - Limits: 16 rooms, 8 connections per room, 64 in total, 5 creations
    per address per minute.
  - Close codes: 4004 (no such room), 4003 (no new room now), 1013 (room
    or server full).
  - The roster gains a spectator count.
  - Rooms record `mode: 'casual'`; nothing reads it yet. It is reserved
    so a future value-bearing mode cannot be confused with casual rooms.
- **Share links.** `/play/<code>`, served by `npm run serve` and by the
  Vite dev server.
  - The welcome carries the canonical link when `PUBLIC_URL` is set.
    Otherwise the page uses its own origin.
  - After creating a room, the page replaces its address with the room
    link, so a reload or reconnect rejoins instead of creating another
    room.
- **Server identity.** `net/serverIdentity.ts`.
  - `PUBLIC_URL` is the one canonical origin. Auth binding, share links
    and the well-known document all use it, and it is never taken from
    forwarded headers.
  - `SERVER_NAME` is a display name.
  - `OPERATOR_PUBKEY` is an npub or hex key, *claimed*: nothing verifies
    that its owner agreed.
  - `/.well-known/rumble.json` is versioned and CORS-open, with only the
    configured fields.
  - Trust labels (`net/serverTrust.ts`):
    - Local: private and loopback addresses, `*.local`, tailnet 100.64/10.
    - Official: on the built-in list *and* over TLS.
    - Community: names an operator.
    - Unknown: everything else.
  - The §11 domain-to-key binding is half done: the well-known document
    is served, but announcements that would need checking against it
    don't exist yet (M8D).
- **Duplicate pubkey.** Allowed. Two connections are two players; nothing
  is merged, taken over or restored.
- **UI.** `client/shell.ts` replaces the M7D overlay and the M8A cards.
  - While playing: chips plus a scoreboard.
  - On demand: the session panel and help (H).
  - When something is wrong: the banner, now with room actions.
  - Debug only: the text HUD, F3 and F4.

---

## M8C-A as built (2026-10-09): sending private invites

**Frozen decisions** (from the M8C0 review):
- NIP-17 kind 14 invites;
- no tickets, and no change to room access;
- recipients given as npub or nprofile;
- 30-minute lifetime;
- no copy for the sender;
- one-time NIP-59 wrapper keys allowed;
- receiving is deferred to M8C-B.

**Message.** content `"<name> invited you to Blobbi Rumble: <room link>"`, with tags:
- `["p", recipient]`;
- `["r", link]`, the same link as in the text;
- `["b", "blobbi:rumble:invite:v1"]`, following the ecosystem's `b` namespace convention (`blobbi:ecosystem:v1`);
- `["expiration", now + 1800]`.

The link comes from the M8B share helper (`shareLink`: the server's
canonical `room.url`, else the page's origin). It must have exactly the
form `http(s)://host/play/<code>`.

**Construction** (`social/nip17.ts`):
- **Rumor:** unsigned, by the sender; its id is its hash.
- **Seal:** `signer.nip44.encrypt` (the extension), then `signEvent` of
  kind 13 with tags `[]` and a timestamp randomly backdated by up to 2
  days. It is checked to verify, be kind 13, carry no tags, and be by the
  rumor's author.
- **Wrap:** nostr-tools `nip44` and `finalizeEvent` with a fresh
  `generateSecretKey()`, held in a local variable inside `giftWrap`. Tags
  are `[p]` plus expiration (the rumor's expiry + up to 1 h of random
  slack); the timestamp is randomly backdated by up to 2 days. Neither
  `nip17.wrapEvent` nor `nip59.wrapEvent` could be used: they need the
  sender's private key.
- **Spec conflict:** NIP-17 suggests putting the expiration on the seal,
  but NIP-59 says a kind 13's tags MUST be empty. We follow the MUST. The
  expiration is on the wrap (relay-visible) and the rumor (authoritative).

**Inbox** (`social/inbox.ts`):
- **Discovery:** kind 10050 from the lookup relays plus up to 2 nprofile
  hints, then from the NIP-65 write relays. These relays only *locate*
  the list.
- **Inbox set:** the list's own `relay` tags, which must literally be
  `wss://`, canonicalised, at most 3, created only by `inboxFromList`
  (checked at run time).
- **Publishing:** `publishGiftWrap` publishes only a kind 1059 that
  verifies, only to that set, through a short-lived `SimplePool` that is
  destroyed afterwards. The lookup pool closes idle relays first
  (`makeRoom`), so the total stays near the 8-relay cap. Success means at
  least 1 relay accepted.
- **Relay AUTH:** `inboxRelayAuth` signs only an exact NIP-42 template
  (kind 22242, empty content, relay tag = one of that inbox's relays, a
  non-empty challenge). nostr-tools calls it only on an `auth-required:`
  rejection, on that relay's connection.
- **The game proof stays socket-only:** the identity module imports none
  of the inbox, NIP-17 or pool code (test-pinned).

**Signer** (`social/signer.ts`): `nip44` is optional and feature-detected,
with timeouts and error classification. Payload shape is checked
(base64, version 2, length bounds) and plaintext is bounded. Without it,
identity is untouched and the panel says invites are unavailable.

**Verification:** `social/verify.ts`, `verifyFresh`. nostr-tools caches a
verdict on the event object under a symbol, and object spread copies
symbols, so a modified copy of a verified event would pass. Found by the
M8C-A tests in new code; M8A/M8B verification was not affected.

---

## M8C-B as built (2026-10-09): receiving private invites (pending real validation)

- **Opt-in.** Nothing is fetched or decrypted until the player clicks
  **Check invites**. The explanation sits beside the button.
- **Inbox.** The player's own kind 10050 list (`findInbox`), at most 3
  `wss://` relays. No list means no check; nothing is published.
- **Fetch.** `subscribeGiftWraps`: `{kinds:[1059], #p:[me], since: now −
  (2 days + 30 min + 10 min), limit: 60}`.
  - Reading only.
  - Relay AUTH goes through the same `inboxRelayAuth` (exact relay, that
    relay's challenge), triggered by a `CLOSED auth-required:` from that
    relay.
  - Events not addressed to me are filtered out.
- **Budget.** 30 decryptions in the first check, newest first (by the
  wrap's own, backdated timestamp), then 30 more for live arrivals while
  the page is open. Each wrap costs **2** NIP-44 decrypt calls (the wrap,
  then the seal).
- **Unwrap** (`unwrapGiftWrap` in `social/nip17.ts`):
  - wrap: verified on a fresh copy, kind 1059, `p` = me, a NIP-44 payload;
  - seal: verified, kind 13, no tags;
  - rumor: well-formed, no `sig`, id = hash, size bounds, author = the
    seal's signer.
  - A refusal or timeout by the signer is reported as such (the check
    stops on a refusal).
- **Recognition** (`parseInvite`):
  - kind 14 with exactly one `["b","blobbi:rumble:invite:v1"]`; any other
    `blobbi:rumble:invite:*` is an unsupported version;
  - `p` = me, exactly one `r` link;
  - `receivedLink`: the canonical `/play/<code>`, `https` unless the host
    is local;
  - the text names exactly that one link;
  - not expired (the lifetime is capped at 35 min from creation whatever
    `expiration` says), at most 10 min in the future, size-bounded.
- **Privacy.**
  - An unrelated rumor never leaves the function that opened it.
  - sessionStorage `rumble:invites-seen:v1:<pubkey>` holds only the ids
    of wraps already judged that are not live invites (at most 300). A
    live invite's wrap is opened again after a reload, since its content
    is not stored.
- **De-duplication** by wrap id and rumor id (several relays deliver the
  same wrap).
- **Identity changes.** A new signer or a disconnect stops the
  subscription, destroys its pool and forgets all in-memory invite state.
  A game-socket reconnect does not, because the inbox follows the page's
  signer, not the game proof.
- **Join.**
  - Explicit only.
  - Same origin: switch room in place.
  - Other origin: `location.assign` to the validated `/play/<code>` URL,
    never through `?server=`.
- **Trust label.** Taken from the destination host only (Local, Official,
  Unknown). `/.well-known/rumble.json` is **not** fetched before joining,
  so nothing contacts the destination before the player chooses to go
  there. As a result a community operator claim is not shown on an
  invite card.

---

## M8C-B.1 as built (2026-10-09): inbox setup (validated for real)

M8C-B's core receive path was validated with two real identities
(Danidfra → NotASage: check, decrypt, card, Join).

**Validated for real on 2026-10-09** with a second pair of identities and a
real NIP-07 extension: Nostr Farm had no kind 10050; Rumble offered the
setup; the player approved a kind 10050 with the three suggested relays;
the extension signed NIP-42 AUTH for `auth.nostr1.com`; the list was
published; Danidfra sent a NIP-17 invite; Nostr Farm received and
decrypted it (after granting the extension's decrypt permission) and
**Join** entered Danidfra's room. M8C-B.1 is frozen.

**Kind 10050** (NIP-17, listed in NIP-51) is a replaceable event: the
newest wins, and on a tie the lowest id (NIP-01). `findInbox` now applies
that tie-break. Its `["relay", url]` tags are where the user receives
private messages. NIP-17 asks clients to keep it to 1–3 relays and to
spread it "to as many relays as viable".

**Suggested inbox relays, probed live on 2026-10-09.** Each was sent a
throwaway kind 1059 to a throwaway key with a 10-minute expiration.

| Relay | Evidence | Decision |
| --- | --- | --- |
| `auth.nostr1.com` | NIP-11 lists 17 and 42 and `auth_required`; reads of 1059 need AUTH (only the recipient reads); writes accepted after AUTH; used in real lists (fiatjaf's, Vitor's) | suggested |
| `relay.nostr.net` | NIP-11 lists 59; reads of 1059 need AUTH; open writes accepted | suggested |
| `nos.lol` | open writes accepted, open reads (less private); used in real lists (jb55's, Jack's); a third operator | suggested |
| `inbox.nostr.wine` | paid; "the inbox you tried to reach does not exist" for non-members | rejected |
| `relay.0xchat.com` | unreachable | rejected |
| `relay.damus.io` | connections refused from this machine in every Node probe | not chosen |
| primal, ditto, offchain, snort, bitcoiner.social | accept writes but serve 1059 to anyone (who receives what is public) | not chosen |

**Where the list is published:**
- the lookup relays (where Rumble and others look first);
- the player's NIP-65 write relays (the outbox, where clients look next),
  at most 3;
- the chosen inbox relays themselves.

That is at most 9, `wss://` only, through `publishInboxList`, which
accepts only the player's own valid kind 10050 (relay tags only, empty
content). Relay AUTH goes through the same exact-relay signer.

**Safety:**
- Setup is offered only when no list was found.
- On confirm it checks again, strictly: at least 2 lookup relays must
  answer (a failed lookup must not read as "none"), and the NIP-65 write
  relays are asked too. If a list turns up, it is used and nothing is
  signed.
- It never retries or re-signs by itself.
- A disconnect or identity switch mid-way discards the run.

**Results:**
- **done / partial:** discoverable (read back from the lookup relays with
  the same event id) and at least 1 chosen inbox relay accepted;
- **unverified:** accepted somewhere, not readable back;
- **failed:** no relay, or no inbox relay, accepted.

The new list is adopted at once (Check invites becomes available).

**Probes.** `probeRelays` is read-only and signs nothing: 'answered',
'auth' (CLOSED auth-required) or 'down'. nostr-tools reports a CLOSED as
an EOSE first, so the 'answered' verdict waits one tick for a close to
override it.

---

## M8C-B.2 as built (2026-10-09): automatic invite checking (pending real validation)

Real M8C-B.1 testing showed the extension asks for NIP-44 decrypt
permission, and that remembering to press **Check invites** on every visit
is the friction. M8C-B.2 lets the page start the same check by itself,
after one explicit consent. The cryptographic receive path is unchanged.

**Consent.**
- Offered once an identity is connected with NIP-44 **and** a located kind
  10050 (`InviteInbox.offersAuto`): "Automatically check for Rumble
  invites?" with the short explanation, **Enable automatic invites** /
  **Not now**. It is a small corner card (hidden while the session panel
  is open, which asks the same) and the same question inside **Invites**.
- Nothing is decrypted before **Enable**.
- The answer is stored in localStorage as `rumble:auto-invites:v1:<pubkey>`
  = `on` | `off`: one preference per identity and per origin, one word,
  nothing else. `off` is also "Not now", so the offer is never repeated;
  **Automatic invites: Off · Turn on** stays in the panel.
- Without NIP-44 or without a list nothing is offered: the M8C-B.1 setup
  flow stays, and nothing is published by this milestone.

**Start.** `InviteInbox.autoStart()` runs after the inbox is located, after
a list is adopted (set up just now) and on **Enable**: with the preference
`on`, NIP-44 present, an inbox found and the phase `idle`, it calls the
same `check()` as the button. From `paused` or `declined` only an explicit
click (Try again, or Enable itself) starts it: nothing retries by itself.

**Catch-up.** The existing one: `since = now − (2 days + 40 min)`, `limit
60` per relay, the newest **30** unseen wraps by `created_at`, remembered
ids skipped without a decrypt call, a live invite's wrap reopened (its
content is not stored), dismissed and expired wraps remembered. Because
gift wraps are backdated at random, `created_at` is not arrival order; the
bound comes from the window plus the remembered ids, not from the
timestamp alone. The decrypt budget is unchanged (30 + 30 live).

**Live.** The same subscription continues after the catch-up while the
page is open, the identity connected and the preference on; a valid new
invite goes to the Invites section, the ✉ badge and the existing toast.
Unrelated wraps are dropped where they are opened, as before.

**Pause.** A `SignerError` of `denied`, `timeout` or `unavailable` from the
signer (M8C-B stopped on `denied` only) stops the run: the subscription and
its pool close, the wrap is **not** marked as judged, and the phase is
`paused` when automatic checking is on ("Automatic invites paused — decrypt
permission needed", a toast once, **Try again**) or `declined` for a manual
check, as before. A pause is not retried by `adopt`, by time or by a game
reconnect; a reload tries once more (the preference is still on), then
pauses again if refused. Rumble never assumes the extension's permission
is permanent, and never works around it.

**Off.** `disableAuto()` writes `off`, closes the subscription and its pool
at once, keeps the invites already shown, resets the phase to `idle` so
**Check invites** works, and leaves the kind 10050 alone.

**Lifecycle.** The inbox follows the page's signer
(`IdentitySession.connectedSigner`), which is the same object across a
game-socket reconnect and a room switch (tested), so neither restarts the
inbox; a new signer or **Disconnect Nostr** stops it and forgets all invite
state. Stale asynchronous work is cut by a generation counter bumped
whenever listening stops: a run that awaited across a stop (the fetch, a
decrypt prompt) goes no further and leaves its wrap unjudged; events a
closed subscription still delivers are ignored.

**Tests** (`inviteInbox.test.ts`, "automatic invites"; `identity.test.ts`):
first-time offer, no offer without NIP-44 or a list, Not now, enable with
a bounded catch-up and live arrivals (duplicates, unrelated), reload with
it on (skipped wraps, rediscovered invite, dismissed stays gone),
per-identity preference, turn off (closed at once, stale events ignored,
manual check works), turn off during a hanging prompt, refusal → paused
with no second prompt (adopt does not restart it; Try again is one more;
a reload tries once), manual refusal still `declined`, setup → adopt →
offer / start, stop while listening, and the signer's stability across
reconnect and room switch.

# FUSE Remote Multiplayer — Implementation Plan

**Status:**
- ✅ **Diagnostics page for the Desktop/Square spike** (2026-07-25).
  `examples/diagnostics/` — a read-only probe built to run *inside* Desktop where
  a console may not be reachable: every answer is on screen and mirrored through
  `app.log()` into Desktop's main.log. Reports `appType`/embedding, page protocol,
  Rapier WASM init, a raw `ws://` open **and** a real relay join, the `setup`
  payload, and a live `app.on('shot')` log. Two dev-server changes came with it:
  requests under `/fuse/examples/...` (Desktop's URL shape) are now rewritten to
  the examples root, and `OGS_DIAG=1` serves the diagnostics page in place of
  whatever game Desktop launches. See the spike steps below.
- ✅ **Honors + course map shows every ball** (2026-07-25). Two play-feel fixes
  from live testing:
  1. **Honors.** The next tee went to roster order, so Lake teed off first after
     an 8 to Brett's 4. Now `CourseGame` keeps a `#honors` list, recomputed from
     the finished hole's scores (low first, ties keep their order), and
     `#findAwayPlayer` uses it to break distance ties — which in practice means
     the tee, where every lie is the same point. Still fully deterministic from
     the scorecards, so networked clients agree with no server involvement.
  2. **Course map.** The ball dot was pinned to the lie, so it never moved in
     flight; it now tracks the live ball. The map also plots every player still
     on the hole (active white, others blue with a name chip; off-frame balls
     pinned to the edge and dimmed).
- ✅ **Lobby (join/leave) + dead turn machinery deleted** (2026-07-25,
  browser-verified). `UILobby` (`src/ui/UILobby.ts`) is the multiplayer front
  door: name(s), room code, relay address, optional secret → live roster → any
  player hits **Start round** → everyone builds the game from the same frozen
  roster. Replaces the old `?expect=N` player-count guess. Once play begins the
  overlay collapses to a corner pill (`ROOM x · N PLAYERS · LEAVE`) so there is
  always a way out. Leaving from the lobby is instant; leaving mid-round reloads
  back into the lobby (a loaded course + physics world + roster-bound CourseGame
  can't be unwound safely). Names are comma separated for the garage case
  ("Lake, Sarah" seats two local players on one machine). Last name/room/server
  are remembered in localStorage; `?room=<code>` still auto-joins for quick
  two-tab testing, `?mp=1` opens the lobby empty.
  - **Protocol v3.** Added `start` (client→server) / `started` (server→client);
    joining a room that has already started is rejected. Deleted the dormant
    turn machinery: `hole_complete`/`turn` messages, `Room.advanceTurn`/
    `finished`/`markHoleComplete`/`allFinishedHole`, `currentPlayerIndex` +
    `currentHoleNumber` on the roster/snapshot, `NetClient.sendHoleComplete`,
    and `CourseGame.setTurn`. `NetClient` also stops reconnecting after a server
    error (they're all fatal join errors — retrying just loops).
  - 32 vitest tests pass. Browser-verified (two tabs): join, live roster, leave
    from the lobby, rejoin, Start, a synced shot with the turn passing to the
    away player, leave mid-round, and the "already started" rejection.
- ✅ **Shot-by-shot "away" turn model + live shots** (2026-07-25,
  browser-verified). Two big changes on top of Phase 3:
  1. **Turn model.** Play is now shot-by-shot: after every shot the turn passes
     to whoever is *farthest from the pin* among players who haven't holed out
     (honors == roster order off the tee); the hole advances only when everyone
     holes out. `CourseGame.applyShotResult` computes this **deterministically**
     (`#findAwayPlayer`, `_advanceHole`) from data every client already has, so
     **no server turn arbitration is needed** — the relay's turn code
     (`hole_complete`/`turn`, `Room.advanceTurn`) is now dormant/unused. Replaces
     the old whole-hole-sequential model. See `src/courses/game.ts`.
  2. **Live re-simulated shots** (replaced the trail-replay "ghost" approach).
     The instant a player swings, `courses.ts` sends a `shot_launch` (shot params
     + start + aim); every other client re-simulates the SAME shot on its own
     ball via `flyRemoteShot` (reusing the real GolfBall + camera-tracking), so
     the ball flies **in sync** (~network latency) instead of after it lands.
     Scoring still comes from the authoritative `shot_result` on rest (GameSync).
     Wire protocol bumped to **v2** (`shot_launch`/`launch` messages added,
     `NetShotResult.trail` removed). `GhostBall`/trail code deleted.
     - **Critical fix (the isReplay guard):** a re-sim reuses the local ball, so
       its `shotEnded` could fire *after* the turn flips to us and get sent as our
       own shot (landing at the remote player's spot → spurious finish). GameSync
       now takes `isReplay()` and suppresses the send for replayed shots.
       Regression-tested. This was the "both players finished at once → jumped a
       hole" bug.
  - 34 vitest tests pass. Browser-verified live (two tabs): away order correct,
    remote shots fly in sync, hole advances only when both hole out.
- ✅ **Phase 3 done + browser-verified** (2026-07-23) — `GameSync`
  (`src/net/gameSync.ts`) wires `NetClient` ↔ `CourseGame`; `courses.ts` builds
  the game from the server roster and locks input off-turn. Commits `ffdf728`,
  `1b7d091`, `e8cdf43`. 33 vitest tests pass incl. a headless two-client
  full-round sync test through a real relay. **Confirmed live in Chrome (two tabs,
  real WebGPU render):** roster gating (waited 1/2, started at 2), Lake's shot
  received on Brett's client, off-turn input blocked, `hole_complete` → both tabs
  advanced the turn and flipped the active player, lock reversed. Works.
- ✅ **Phase 2 done** — `CourseGame` refactor + ownership.
- ✅ **Phase 1 done** — relay server + `NetClient` + in-process relay.
- Desktop empirical spike (needs the app + a Square) still pending; not a blocker.
- **Next: Phase 5** robustness (disconnect/rejoin, live roster changes, pre-load
  race). Plus polish ideas surfaced during play — see "Backlog" below.

**Verify in a browser (the one thing tests can't cover):** with `npm run dev`
running (it hosts the relay), open two tabs on
`courses/index.html?courseUrl=<glb>&room=<fresh-code>&name=Lake` and
`...&name=Brett` — both land in the lobby and auto-join. Hit **Start round** on
either, then fire keyboard shots (1-9 / space) on the active tab: the other tab
should fly the same shot live, the turn should pass to whoever is farthest from
the pin, and off-turn input should be ignored. The `LEAVE` pill under the range
finder drops you back to the lobby. Use a *fresh* room code each run (see the HMR
gotcha below).

**Dev testing gotcha (not a production bug):** with `npm run dev`, the first page
load can trigger a vite dependency re-optimization that HMR-reloads *all* open
tabs mid-session, re-executing the entry module and leaving duplicate
NetClient/renderer instances (seen as double "joined"/"starting" logs). Cause: a
second tab pulling a not-yet-optimized dep. Avoid it by loading one tab first to
warm the optimizer, then hard-reloading both before testing — or restart the dev
server (which also clears relay room state) and load tabs one at a time. Doesn't
affect a built deploy (no HMR). `setupMultiplayer` isn't HMR-safe; low priority.

**Two known Phase-3 gaps to close in Phase 5:**
- Live roster changes after start are ignored (a late joiner / disconnect isn't
  handled). Fine for "both tabs open, then play."
- Small race: if one client shoots before another finishes loading the course
  (GameSync is created after the GLB loads), the slow client can miss that shot.
  Mitigate by creating GameSync earlier or buffering pre-load messages.
**Written:** 2026-07-22
**Repo:** clone of `OpenGolfSim/fuse` @ `6f10092` (`fix: short chip physics (#14)`)

---

## Backlog — what's left (2026-07-25)

**The real goal:** Lake + 1 local player in the garage + Brett remote, playing a
real round on the Square. Everything below is toward that.

1. **Empirical Desktop + Square spike** (only the user can run — needs the app +
   a launch monitor). Confirm: `OGS_APP_URL` points Desktop at our local/fork
   build; the Desktop-loaded fuse page can open `ws://` to the relay; Square
   shots flow through as `app.on('shot')`. This validates the whole thing on real
   hardware. See the Desktop spike notes further down.
2. **Real-world connectivity.** For Lake↔Brett over the internet: run the
   standalone relay (`npm run server`, set `OGS_MP_SECRET`), port-forward its
   port, and point Brett at `&server=<lake-ip>:<port>&secret=…`. Validate once
   end-to-end. (The in-process vite relay is dev-only.)
3. **Phase 5 — robustness.** Disconnect/rejoin so the roster survives a client
   dropping mid-round — note the lobby now *rejects* a join to a started room, so
   a network blip currently ends that client's round (needs a stable client key
   the room can match a returning player against); live roster changes after
   start are still ignored (mid-round the other clients keep playing the frozen
   roster, including the leaver's players); pre-load race (a shot that arrives
   before a client finishes loading the GLB can be missed — GameSync is created
   after load); an in-game "waiting for Brett…" indicator.
4. ✅ ~~**Tidy-up** of the dead server turn machinery~~ — done 2026-07-25 with
   the lobby work (protocol v3).
5. **Play-feel polish (surfaced while testing).** The ~3s post-shot settle before
   the next player is noticeable; the gimme/auto-putt "you're done the instant you
   touch the green" (even from ~20m) can feel abrupt — worth revisiting the
   putting/gimme UX for shot-by-shot. Optional live ghost-landing reconciliation
   if re-sim ever visibly diverges from the authoritative landing.

---

## Goal

Add remote multiplayer to FUSE's existing course mode, so a garage sim with two
local players sharing one launch monitor can play a round against a third player
(Brett) on a different machine in a different place.

**The hybrid requirement is the design driver:** a network client owns a *set* of
players, not a single player. Local hot-seat rotation becomes a subset of the
global turn rotation.

| Client | Owns players |
|---|---|
| Garage machine | `[me, garage-buddy]` |
| Brett's machine | `[brett]` |

Local-only play is then just "one client owns every player," which is why the
Phase 2 refactor must leave current single-machine behavior byte-for-byte
identical.

**Scope:** personal use, not targeting an upstream PR right now. Keep changes
reasonably clean anyway — upstreaming later shouldn't require a rewrite, and the
maintainer already has a TODO pointing this direction (`src/app.ts:215`:
`// TODO: use a cloud-based websocket here to sync for web play?`).

---

## Why this is tractable

Golf is turn-based with independent balls. There is **no need for state sync,
lockstep, determinism, or rollback**. Each client simulates only its own
players' shots with its own launch monitor. The only thing crossing the network
is a shot *result*, at roughly one message per 30 seconds.

The wire format already exists — `OpenGolfSim.ShotResultEvent`
(`src/globals/globals.d.ts:89-103`):

```ts
interface ShotResultEvent {
  type: 'result';
  data?: Partial<ShotResult>;        // apex, carry, total, roll, lateral
  shot?: Shot; club?: Club; surface?: string; player?: Player;
  startPosition?: [number, number, number];
  landPosition?:  [number, number, number];
  endPosition?:   [number, number, number];
  ballTrail?: [number, number, number][];   // declared but NEVER populated
  heightSamples?: number[];
  distanceSamples?: number[];
  lateralSamples?: number[];
}
```

That is enough to replay a remote player's shot as a ghost ball with a trail.
`BallTrail` (`src/objects/ballTrail.ts`) already exists to render it.

---

## Architecture decisions (settled)

### 1. Relay + server-authoritative turn order

Small Node + `ws` server. Clients connect to a room. Server is the single source
of truth for **whose turn it is**.

### 2. Server owns turn order and roster. Clients own their own scoring.

Full server-authoritative scoring would mean reimplementing gimmes, auto-putt,
and hole-out rules (`src/courses/game.ts:152-181`) a second time in Node and
keeping two copies of golf rules in sync forever. Since this is a private game
among friends, cheat resistance is worth nothing. A client reports "I holed out
in 4"; the server arbitrates only turn order and roster.

### 3. Do NOT apply local shots optimistically — wait for the server echo

When the local ball stops, send the result to the server and do nothing else.
Apply game-state changes only when the server's broadcast arrives.

The ball has already visually come to rest, so a ~50ms round trip before the
scorecard updates is imperceptible. In exchange there is **exactly one code path
that mutates game state**, identical for local and remote shots. This eliminates
client/server divergence as a category of bug. Do not "optimize" this away.

### 4. Remote shots are visual replays, not simulations

Never run Rapier for a remote player's shot. Interpolate the sample arrays and
leave a marker at `endPosition`.

---

## Map of the existing code

### The core coupling problem

`src/courses/game.ts:58` — turn advancement has exactly one trigger:

```ts
this.golfBall.on('shotEnded', (details) => this._onShotEnded(details));
```

`_onShotEnded` (`game.ts:139-186`) then reaches directly into the local ball:

- `game.ts:156` — `this.activePlayer.start.copy(this.golfBall.object.position)`
- `game.ts:158` — `this.golfBall.physics?.isHoled`
- `game.ts:163-180` — green / gimme / auto-putt scoring, then `_nextPlayer()`

Everything else in `CourseGame` is already player-array-based and needs little
or no change:

| Location | What it does | Multiplayer impact |
|---|---|---|
| `game.ts:41` | builds `players` from `setupData.players` | roster must come from server instead |
| `game.ts:206-217` | `#findNextPlayerUp()` | fine as-is if rosters match |
| `game.ts:219-221` | `#allPlayersFinishedHole()` | fine as-is |
| `game.ts:223-237` | `_nextPlayer()` | becomes server-driven |
| `game.ts:247-256` | `selectPlayer()` | **permissions hole** — currently lets anyone jump to any player. Must be restricted to owned players. |
| `game.ts:188-192` | `switchHole()` | needs to be server-driven or disabled in MP |

### Other relevant files

- `src/courses/player.ts` — `CoursePlayer` (45 lines): `strokes`, `toPar`,
  `scorecard: Map`, `start`/`aim`/`pin` vectors, `disabled` flag.
- `src/objects/golfBall.ts:10-14` — `GolfBallEvents.shotEnded` signature:
  `(details: { surface?: CourseSurfaceProperties, isHoled: boolean }) => void`
- `src/objects/golfBall.ts:26-39` — `ShotStats`, incl. the three sample arrays.
- `src/app.ts:144` — `sendShotResult()` already serializes a full result to the
  host app. Good template for the network payload; reuse its shape.
- `src/app.ts:133` — `sendPlayerUpdate()` already broadcasts player position +
  club. Built with spectating in mind.
- `examples/courses/courses.ts` — the wiring: `setupNextShot()`, `launchShot()`,
  `initializeDebug()`, `app.on('setup')`, `app.on('shot')`, the `animate()` loop.
- `src/utils/data.ts:34` — `generateSetupData(playerCount, override)` fabricates
  players/clubs for browser testing.

### Hard constraint: the Desktop app is closed source

`opengolfsim-desktop` is an issues-only repo. `setupData` is injected *by*
Desktop, so lobby/matchmaking cannot live there for us.

**Workaround:** `initializeDebug()` in `examples/courses/courses.ts` fakes the
entire setup handshake from a `?courseUrl=` query param via
`generateSetupData(1)`. Everything below is built and tested purely in the
browser. Desktop integration is a later problem (and may never be needed).

---

## Phase 1 — Relay server + net client

**No changes to game code.** Goal: two browser tabs can join a room and see each
other's roster.

### 1a. Server: `server/` (new, top-level)

Own tiny `package.json` — do not add `ws` to the FUSE package's deps.

```
server/
  package.json        { "type": "module", deps: ws }
  index.js            standalone entry (npm run server)
  relay.js            createRelay({ port }) — exported, no side effects on import
  room.js             Room: clients, roster, turn state
```

Node v25 is installed. Node has a built-in WebSocket *client* but not a server —
`ws` is required.

**The host runs the relay.** Whoever "creates the game" runs it on their machine.
Write `relay.js` as an importable factory so it can be started two ways without
duplicating code:

1. Standalone — `npm run server` (also what a future Fly.io/Railway deploy uses)
2. **In-process with vite** — a plugin in `vite.config.examples.js` calls
   `createRelay()` from its `configureServer(server)` hook, so `npm run dev`
   alone both serves the game and hosts the room. There is already a
   `custom-cli-message` plugin using that hook; add alongside it, and print the
   room's LAN/tailnet URL in the same startup banner.

Option 2 is the target UX: host runs `npm run dev`, joiner runs `npm run dev`
and points at the host's address.

**Room state (authoritative):**

```js
{
  code: 'garage',
  courseUrl: '<glb url>',        // first client to join sets it; others must match
  clients: Map<clientId, { socket, playerIds: string[], alive: bool }>,
  roster: [{ ...OpenGolfSim.Player, ownerId: clientId }],   // ordered = honors off the tee
  started: false,               // true once someone hits Start; late joins rejected
}
```

> **Updated (v3):** the room holds no turn or hole state at all. Turn order is
> derived identically on every client from the shot results (the "away" model),
> so there is nothing for the server to arbitrate.

> **Player IDs must be namespaced on join.** In *dev*, `generateSetupData`
> (`src/utils/data.ts:34`) emits `player-1`, `player-2` — two dev clients both
> claim `player-1`. Real Desktop golfers use UUIDs (confirmed: `config.json` has
> `id: "70780128-0767-…"`), so real-vs-real collision is unlikely, but dev-vs-dev
> and dev-vs-real are still live. Cheap and universal fix regardless:
>
> On join, rewrite every incoming player id to `${clientId}:${player.id}` and use
> that everywhere in the roster. The client keeps a local map back to its own
> original ids for UI. Do this in Phase 1, not later; every subsequent phase
> assumes roster ids are globally unique.

**Protocol** (JSON over WS; `type` discriminated, mirroring the existing
`AppBridge` message style):

Client → server:
| type | payload | meaning |
|---|---|---|
| `join` | `{ protocolVersion, roomCode, roomSecret, courseUrl, players: Player[] }` | claim ownership of these players |
| `shot_result` | `{ playerId, result: NetShotResult }` | my player finished a shot |
| `shot_launch` | `{ playerId, launch: NetShotLaunch }` | my player just swung — fly it live |
| `start` | `{}` | close the lobby, start the round for everyone |
| `leave` | `{}` | graceful exit |

Server → client:
| type | payload | meaning |
|---|---|---|
| `joined` | `{ clientId, room: RoomSnapshot }` | ack + full state |
| `roster` | `{ roster, started }` | someone joined/left |
| `shot` | `{ playerId, result }` | rebroadcast (sent to everyone incl. origin) |
| `launch` | `{ playerId, launch }` | rebroadcast — re-simulate this shot now |
| `started` | `{ roster }` | lobby closed; build the game from this frozen roster |
| `error` | `{ message }` | bad join, courseUrl mismatch, version mismatch, room started |

`protocolVersion` is a hardcoded integer, bumped by hand whenever the message
shapes change. Two people running different commits is the expected failure mode
here — reject the join with a readable message rather than letting it desync
mysteriously an hour into a round.

`roomSecret` is a shared string the host sets (env var or CLI flag) and passes to
the joiner in the URL. **This relay is exposed to the open internet with no other
auth** — unlike a Minecraft server, there is no account verification and no
allowlist, so without a secret anyone who finds the port can join the room, claim
another player's `playerId`, or inject shot results. Constant-time compare, and
reject before doing any other work on the message.

Related server hygiene, since it will get portscanned:

- Wrap all `JSON.parse` / message handling in try-catch; never crash on garbage
- Ignore messages from a socket that has not completed `join`
- Reject `shot_result` / `shot_launch` for a `playerId` the sending client does
  not own (also prevents honest bugs, not just abuse)
- Cap message size and room size

Note `shot` goes to **everyone including the originator** — that is what makes
decision #3 work (single code path).

Turn advance on the server is a port of `#findNextPlayerUp()`
(`game.ts:206-217`): rotate from `currentPlayerIndex`, skipping players who have
finished the current hole; when all are done, advance the hole.

### 1b. Client: `src/net/` (new)

```
src/net/
  client.ts     NetClient extends EventEmitter — connect, send, auto-reconnect
  types.ts      shared message types (hand-mirrored into server/ for now)
```

`NetClient` mirrors `AppBridge`'s style — `eventemitter3`, typed `EventMap`.
Keep it dumb: connection lifecycle, JSON framing, reconnect with backoff, event
emission. **No game logic.**

Export from `src/index.ts` alongside the other modules.

### 1c. Verification for Phase 1

Add `?room=<code>` parsing next to the existing `?courseUrl=` / `?quality=` /
`?practice=` handling in `preLoad()`. Open two tabs, confirm both log a `roster`
containing all three players. Nothing else should change.

---

## Phase 2 — Refactor `CourseGame` (no networking)

**This phase must not change single-machine behavior.** It is independently
testable and independently valuable.

### 2a. Extract `applyShotResult()` from `_onShotEnded()`

Split the ball-reading from the bookkeeping:

```ts
/** Pure data in; no reference to this.golfBall. Works for any player. */
applyShotResult(playerId: string, result: {
  endPosition: THREE.Vector3;
  surface?: CourseSurfaceProperties;
  isHoled: boolean;
}) {
  const player = this.players.find(p => p.id === playerId);
  // ...everything currently in game.ts:144-185, but against `player`
  // instead of `this.activePlayer`, and `result.endPosition` instead of
  // `this.golfBall.object.position`
}
```

The existing local handler becomes a thin adapter that reads the ball and calls
the new method:

```ts
this.golfBall.on('shotEnded', (details) => {
  this.applyShotResult(this.activePlayer.id, {
    endPosition: this.golfBall.object!.position.clone(),
    surface: details.surface,
    isHoled: !!this.golfBall.physics?.isHoled,
  });
});
```

Watch out: `_addStrokes()` (`game.ts:122-137`) mutates `this.activePlayer`
implicitly. It needs a player parameter too. Same for the `toPar` recompute at
`game.ts:131-135`.

### 2b. Add ownership

```ts
localPlayerIds: Set<string>;                  // ctor option; defaults to ALL players
get isLocalTurn(): boolean { return this.localPlayerIds.has(this.activePlayer.id); }
```

Defaulting to *all* players is what preserves current behavior — a single-machine
game owns everyone and `isLocalTurn` is always true.

Restrict `selectPlayer()` (`game.ts:247`) to `localPlayerIds`.

### 2c. Allow externally-driven turn advance

Add a way to set the active player/hole from outside without re-running local
scoring — `setTurn(playerId, holeNumber)` — for the server's `turn` message to
call in Phase 3. `_nextPlayer()` stays for local play.

> **Superseded.** `setTurn` was built, then deleted in the v3 tidy-up: with the
> shot-by-shot "away" model every client derives the same turn from the shot
> results, so there is no external turn to apply.

### 2d. Verification for Phase 2

```bash
npm run dev
# open courses/index.html?courseUrl=https://coursedata.opengolfsim.com/webgl/courses/mountain-vista/v4/mtn-vista-trees-v6.glb
```

`CourseKeyboardControls({ testShots: true })` is already set at
`examples/courses/courses.ts` — number keys 1-9 and space fire test shots, no
launch monitor needed.

Check with `generateSetupData(2)` (edit `initializeDebug()` temporarily) that
hot-seat rotation, scorecard, gimme/auto-putt, hole advance, and round end all
behave exactly as they do on `main` today. **Diff behavior against a stashed
build if unsure.** This is the safety gate for everything after it.

---

## Phases 3–5 (sketch — flesh out after 1 & 2 land)

**Phase 3 — Wire the loop.** `NetClient` + `CourseGame` meet in
`examples/courses/courses.ts`. Local `shotEnded` → `shot_result` to server →
`shot` broadcast → `applyShotResult()` on every client (which advances the turn
itself — the `turn`/`setTurn` step in this sketch was later dropped).
Roster comes from the server instead of `setupData.players`. Playable round
across two tabs, shared scorecard. (Ghost balls added in Phase 4.)

**Phase 4 — Ghost balls. ✅ DONE (2026-07-24).** Chose to send the ball's own
world-space trail (`golfBall.getTrailPoints()`) rather than reconstruct from the
three sample arrays — no math, and it matches the real ball's path exactly. The
trail rides inside `NetShotResult.trail` (optional, downsampled to ≤240 pts,
endpoints preserved) so scoring-only messages stay valid and no server change is
needed. `GhostBall` (`src/objects/ghostBall.ts`) owns a sphere + `BallTrail` and
flies the path at constant velocity via `update(delta)` from the render loop,
then lingers ~2.5s and clears. `courses.ts` plays it only for non-local players
(own shots already show the real ball). Skipped the `ballTrail` globals field —
unnecessary. Still needs a two-tab browser check to watch a shot actually fly.

**Phase 5 — Robustness.** Disconnect/rejoin (roster must survive a client
dropping mid-round), "waiting for Brett…" UI state, input lockout when
`!isLocalTurn`, and handling a client that leaves permanently (skip their
players rather than stalling the rotation).

---

## Dev loop (all phases)

```bash
npm install
npm run dev
# then two tabs:
# courses/index.html?courseUrl=<mountain-vista-glb>&room=garage
```

Mountain Vista GLB (from `public/games.json`):
```
https://coursedata.opengolfsim.com/webgl/courses/mountain-vista/v4/mtn-vista-trees-v6.glb
```

No Desktop app, no launch monitor, no Brett required until Phase 3 works.

---

## Playing for real (host + remote joiner)

Target flow: both clone this branch, both run `npm run dev`, host's process also
carries the relay (see 1a option 2). Joiner opens a URL pointing at the host:

```
courses/index.html?courseUrl=<glb>&room=garage&server=100.101.102.103:8080
```

There is **no lobby/create/join UI** anywhere in Phases 1–5. Sharing a URL is the
interface. That is fine for two people; note it before scope-creeping.

### Connectivity: port forwarding (confirmed viable)

The host has successfully port forwarded a Minecraft server from this network, so
CGNAT is ruled out and forwarding a port to the relay is the primary plan.

Two carry-overs from that setup:

- Dynamic WAN IP — same problem Minecraft had. Whatever was used there (DDNS, or
  just re-sending the address) applies unchanged.
- **Set `roomSecret`.** Minecraft had online-mode auth and an allowlist; this
  relay has neither. See the protocol notes above.

Optional alternative, not required: Tailscale puts both machines on a virtual LAN
(`100.x.x.x`) with no router config and no exposed port. Worth it only if the
dynamic IP becomes annoying. Cloudflare Tunnel / ngrok are also fine, though both
hand out a URL that changes on restart.

### TLS is not needed — and don't accidentally need it

Both clients load the game from vite over `http://localhost:5173`. An `http://`
page may open a plain `ws://` connection, so no certificates are required.

If the dev server is ever moved to `https://`, browsers will force `wss://` and
the relay suddenly needs TLS too. Don't switch one without the other.

### Assets are not a problem

The course GLB is fetched from `coursedata.opengolfsim.com` by both clients, so
geometry is identical with no syncing. Only the code needs to match — which is
what `protocolVersion` guards.

### How OGS Desktop runs fuse — findings from the v1.17.1 spike (2026-07-23)

> **Correction log.** This section was rewritten twice. (1) The original plan
> assumed real play = a custom game packaged *inside* Desktop via
> `window.ogsElectron`, and worried about Desktop's CSP. (2) A mid-spike draft
> then claimed "Desktop can't run fuse at all" — **also wrong**, contradicted by
> the running app (fuse games appear in the library with an "F" icon and launch
> fine). The static asar read missed the launcher. The facts below come from the
> app's own runtime **logs**, which are authoritative. Keep this history so we
> don't relitigate it.

#### Ground truth from the Desktop logs (`~/Library/Logs/opengolfsim-desktop/main.log`)

```
[debug] (ipc)   Launching course (fuse_range)
[info]  (WEBGL) Launching https://app.opengolfsim.com/fuse/examples/range/index.html
[info]  (WEBGL) shot { ... }        ← Square shots flow into the fuse game
```

So Desktop **does** run fuse. It:
- Loads the game from a **remote HTTPS URL**, `${app_url}/fuse/examples/.../index.html`.
- `app_url` defaults to `https://app.opengolfsim.com` but is **overridable** —
  `OGS_APP_URL` env var, or an `app_url` key in the asar's `config.json`
  (`lib/config.js:29-55`). This is the hook that could point Desktop at our fork.
- Delivers Square shots into that page (the `(WEBGL) shot` log lines).

The launcher logs under a `WEBGL` scope; the embedding mechanism (iframe vs child
window) was not pinned down statically — the shipped `client/dist/bundle.js`
contains no `/fuse/` or `webgl` strings, so the embedding likely lives in code
served from `app.opengolfsim.com` itself. **This is one of the things the
empirical spike below will reveal** (via the fuse page's own `app.appType`).

#### What this means: Desktop loads *their* fuse, not *ours*

The decisive constraint is not "can Desktop run fuse" (it can) but **"Desktop
loads a fixed remote build we don't control."** Our multiplayer code only reaches
a real Square this way if we can point `app_url` at our own build. So there are
two candidate real-play paths.

**Path A — override `app_url` to our fork (preferred if it works).**
Serve our multiplayer fuse fork locally over http, set `OGS_APP_URL` (or
`config.json` `app_url`) to it, and let Desktop drive it exactly as it drives the
hosted app: it loads our page and pipes Square shots in through its existing WEBGL
channel. Our fork then opens `ws://` to the relay for multiplayer sync.
- If Desktop embeds fuse as an **iframe** using `postMessage`, our fork already
  supports it: `appType: 'webapp'` (`src/app.ts:72`, `window.self !== window.top`)
  → shots arrive via `window.addEventListener('message')`, results go back via
  `window.parent.postMessage`. **No fuse code change needed to receive shots.**
- The open question for Path A is the **original one, now genuinely live**: can a
  page loaded this way open a `ws://` to the relay? If our page is served from
  `http://localhost:PORT`, its origin is http → it may open `ws://` freely
  (localhost is a trustworthy origin; mixed-content blocking only applies to
  https *pages*). If instead it ends up in a secure/`https` context, browsers
  force `wss://` and the relay needs TLS. **Must be measured, not assumed.**

**Path B — plain browser + a shot bridge from Desktop's Developer API (fallback).**
Run our fork in a normal browser tab and get Square shots from Desktop's
Developer API: `lib/developerAPI.js` runs an always-on **raw TCP server on
`localhost:3111`** (started unconditionally for any signed-in user,
`lib/system/services.js:28`; port overridable via `launchMonitor.apiPort`).
- ⚠ **Caveat that weakens Path B:** the `:3111` broadcasts observed in code fire
  on the *native Unity* `result`/`player` events (`lib/launch/index.js:61,71`).
  During a **fuse** session the native core isn't the simulator, so `:3111` may be
  **silent**. Whether raw Square shots hit `:3111` independent of the active
  engine is **unverified** and is the first thing to test if we go this route.
- If it does emit, a browser can't open raw TCP anyway, so this path needs a small
  Node **bridge**: TCP client to `:3111` → `ws://localhost` → our page (feed into
  `launchShot()` where `testShots` does today). ~40 lines. The bridge doubles as a
  place to co-host the relay.

**Recommendation:** try Path A first — it reuses Desktop's own shot pipe and needs
no bridge. Fall back to Path B only if the `app_url` override doesn't take or the
`ws://` connection is blocked by a secure context.

#### ⚠ First task before Phase 3 — an empirical spike (needs the running app + a Square)

Only the user can run this (GUI + hardware). **Tooling for it now exists** — see
"Diagnostics page" below; the steps are:

```bash
OGS_DIAG=1 npm run dev          # serves the diagnostics page for any game Desktop launches
OGS_APP_URL=http://localhost:5173 open -a "OpenGolfSim Desktop"
```

then launch any fuse game from the Desktop library and read the screen. It reports
`app.appType`, the embedding, the page protocol, whether Rapier's WASM initialized,
whether a `ws://` socket opens **and** completes a real relay join, the `setup`
payload, and a live log of `app.on('shot')` events. Take one real swing to finish it.

- Page loads at all → Path A viable.
- `ws://` row green → the whole real-play story is just "override `app_url`".
  Red on an https page → mixed content; the relay needs TLS or Path B.
- Shots appear → the Square reaches our build; nothing else in the shot path
  differs from the keyboard test shots we've been developing against.

**Path-shape finding (2026-07-25):** Desktop requests
`${app_url}/fuse/examples/<game>/index.html`, but the dev server's root is
`examples/`, so those URLs 404ed. `vite.config.examples.js` now has an
`ogs-desktop-compat` middleware that strips the `/fuse/examples` prefix — without
it step 1 fails for a reason that has nothing to do with whether Path A works.

If step 1 loads and step 2's WebSocket opens, Path A is green and the whole
real-play story is just "override `app_url`, open `ws://` to the relay." If the
WebSocket is blocked, we either give the relay TLS (`wss://`) or fall back to
Path B and verify `:3111` emits during fuse play.

### Stray shots are now a real problem, not a hypothetical

With live hardware, someone hitting a practice ball out of turn is guaranteed to
happen. The client **must drop inbound `app.on('shot')` events when
`!isLocalTurn`**, and should also ignore them while a local shot is still
resolving. Listed under Phase 5 but treat it as required for the first real
round with Brett — without it, a stray swing corrupts the shared scorecard.

---

## Open questions / to do

- [ ] **Ping the maintainer on Discord before Phase 3.** The `app.ts:215` TODO
      suggests they've considered this; the README already claims "multiplayer
      support" for local play. Worth 10 minutes to avoid a collision, even
      though we're not upstreaming immediately.
- [ ] ~~Where does the relay server run for real play?~~ **Resolved:** the host
      runs it in-process with `npm run dev` over Tailscale. See "Playing for
      real". A hosted deploy stays possible via the standalone entry but is not
      needed.
- [ ] `courseUrl` mismatch between clients — currently planned as a hard error on
      join. Confirm that's the behavior we want.
- [ ] Does `CourseLoader` care about player count at all? (Believed no — it only
      loads course geometry — but verify before assuming.)
- [ ] Mulligans (`previousStart`, `game.ts:147-150`) interact with the shared
      scorecard. Undefined in MP. Decide later.
- [ ] `switchHole()` via `UICourseMap` (`courses.ts`, `on('holeChange')`) lets a
      player jump holes freely. Must be disabled or server-driven in MP.
- [x] ~~**Hole-out scoring bug (found during Phase 2).**~~ **Fixed** 2026-07-23.
      The `isHoled` finalize ran *after* `_nextPlayer()`, scoring the next player
      a spurious `0` (which `hasFinishedHole()` treated as "finished"). Reordered
      to finalize the shooter then rotate, matching the green/auto-putt branch.
      Regression test in `test/game.test.ts`.

---

## License note

FUSE is **PolyForm Noncommercial 1.0.0** (`LICENSE.md`), despite `package.json`
saying `"license": "ISC"`. Fine for private use with friends. Anything
commercial requires contacting help@opengolfsim.com.

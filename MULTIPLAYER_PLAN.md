# FUSE Remote Multiplayer — Implementation Plan

**Status:** Not started. Phases 1 & 2 are next.
**Written:** 2026-07-22
**Repo:** clone of `OpenGolfSim/fuse` @ `6f10092` (`fix: short chip physics (#14)`)

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
  roster: [{ ...OpenGolfSim.Player, ownerId: clientId }],   // ordered = turn order
  currentPlayerIndex: 0,
  currentHoleNumber: 1,
}
```

> **Player IDs must be namespaced on join.** `generateSetupData`
> (`src/utils/data.ts:34`) emits `player-1`, `player-2`, and Desktop's configured
> golfer list is likely to do something similar. Two clients will therefore both
> arrive claiming `player-1`, and the server would silently merge them —
> corrupting scorecards and the turn rotation.
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
| `shot_result` | `{ playerId, result: ShotResultPayload }` | my player finished a shot |
| `hole_complete` | `{ playerId, holeNumber, strokes }` | my player finished a hole |
| `leave` | `{}` | graceful exit |

Server → client:
| type | payload | meaning |
|---|---|---|
| `joined` | `{ clientId, room: RoomSnapshot }` | ack + full state |
| `roster` | `{ roster, currentPlayerIndex, currentHoleNumber }` | someone joined/left |
| `shot` | `{ playerId, result }` | rebroadcast (sent to everyone incl. origin) |
| `turn` | `{ playerId, holeNumber }` | authoritative turn advance |
| `error` | `{ message }` | bad join, courseUrl mismatch, version mismatch |

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
- Reject `shot_result` / `hole_complete` for a `playerId` the sending client does
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
`shot` broadcast → `applyShotResult()` on every client → `turn` → `setTurn()`.
Roster comes from the server instead of `setupData.players`. Playable round
across two tabs, shared scorecard, no ghost balls yet.

**Phase 4 — Ghost balls.** On `shot` for a non-local player, spawn a lightweight
sphere + `BallTrail` and animate along `heightSamples`/`lateralSamples`/
`distanceSamples`. Consider finally populating the unused `ballTrail` field
(`globals.d.ts:99`) with world-space points — simpler than reconstructing from
the three sample arrays, at the cost of a bigger payload. Leave a marker at
`endPosition`.

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

### Launch monitors: two run modes, and they are not the same

Both participants use a **Square** via `ogs-plugin-square`. The plugin is not a
problem in itself — each machine has its own launch monitor feeding its own
Desktop feeding its own client, which maps cleanly onto player ownership. But it
dictates *where the game runs*:

```
Square LM --bluetooth--> ogs-plugin-square --shotData.sendShot()--> Desktop
                         (sandboxed, no require/import)               |
                                                          window.ogsElectron
                                                                      v
                                                    AppBridge --> app.on('shot')
```

Plugins live in `.../opengolfsim-desktop/plugins/` and run *inside Desktop*.
A browser tab has no `window.ogsElectron` (`src/app.ts:68-74` sets
`appType = 'web'`), so **the Square plugin can never deliver shots to the vite
dev server.**

| | Dev mode | Real play |
|---|---|---|
| Runs in | browser via `npm run dev` | OGS Desktop, as a custom game |
| Shot source | `testShots: true` keyboard | Square via plugin |
| `app.appType` | `'web'` | `'desktop'` |
| Iteration | instant, HMR | `npm run build` + copy to Desktop |

Real play means packaging as a custom game: a folder in
`~/Library/Application Support/opengolfsim-desktop/fuse/<name>/` containing
`game.json` + built `index.html` (see main README). Desktop then supplies
`setupData.players` from its configured golfers — which is exactly the per-client
player set the ownership model wants.

### ⚠ Test this before building Phase 3

**Can a custom game running inside OGS Desktop open a WebSocket to an arbitrary
host?** Electron apps commonly set a Content Security Policy restricting
`connect-src`. If Desktop blocks it, the client cannot reach the relay in real
play and the architecture needs rework — so find out early. A ten-line custom
game that tries `new WebSocket(...)` and logs the result is enough.

Fallback if blocked: the plugin sandbox exposes `webSockets.createWebSocket()`
(`ogs-plugin-square/plugins.d.ts`), so a plugin can reach the network even when
the renderer cannot. Bridging plugin → game is awkward (`shotData.sendShot()` is
the only channel into the game and it is shot-shaped), but it is not a dead end.

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

---

## License note

FUSE is **PolyForm Noncommercial 1.0.0** (`LICENSE.md`), despite `package.json`
saying `"license": "ISC"`. Fine for private use with friends. Anything
commercial requires contacting help@opengolfsim.com.

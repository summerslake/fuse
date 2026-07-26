# Remote multiplayer for FUSE

Two people in different houses, each with their own launch monitor, playing one
round together — shot by shot, watching each other's balls fly in real time.

**Status: working.** A full 9-hole round was played over the internet on
2026-07-26 (OGS Desktop + Square launch monitors on both ends), start to finish,
with no intervention.

It also covers the case it was designed around: **two players sharing one
machine in a garage, plus a third playing remotely.** A network client owns a
*set* of players, not a single player, and local hot-seat play is a subset of the
global rotation.

---

## How it works

```
  Lake's machine                    relay                    Brett's machine
  ─────────────                   ───────                    ───────────────
  swing ──▶ shot_launch ────────────▶ ─────────────────────▶ re-simulate the
            (params, start, aim)      broadcast               same shot live
                    │
  ball settles ──▶ shot_result ─────▶ ─────────────────────▶ apply + score
                    │                 broadcast to everyone,
                    ▼                 including the sender
              apply + score
```

Four ideas carry the design:

**The relay is deliberately dumb.** It owns the roster and nothing else — no
turn state, no scoring, no physics. It namespaces player ids, checks that a
client only sends shots for players it owns, and rebroadcasts.

**Turn order is derived, not arbitrated.** Play is shot-by-shot: after every
shot the turn passes to whoever is farthest from the pin among players who
haven't holed out, with honors (low score on the previous hole) breaking the tie
on the tee. Every client computes this from the same shot results, so they agree
without the server having an opinion. `CourseGame.applyShotResult` is the whole
of it.

**Shots are re-simulated, not streamed.** On a swing we broadcast the launch
parameters immediately; every other client runs the same shot through its own
physics. The ball flies in sync (~latency) rather than after it lands, and there
is no position streaming.

**Scoring is authoritative from the shooter.** The visible flight is a local
re-simulation, but the score comes from the shooter's `shot_result` when the ball
comes to rest — so tiny physics divergence can never accumulate into disagreement.

Because scoring and turn order are deterministic, **replaying the shot log
rebuilds a round exactly.** That's what makes reconnect work: the relay keeps an
ordered log, and a client that drops, reloads, or joins late is replayed back to
the current state rather than approximately near it.

---

## Wire protocol (v4)

JSON over WebSocket, `type`-discriminated, mirroring `AppBridge`'s style.

| Client → server | Meaning |
|---|---|
| `join` | claim these players; carries `clientKey` (stable across reconnects) and `sinceShot` |
| `shot_launch` | I just swung — fly this live |
| `shot_result` | my ball came to rest here |
| `start` | close the lobby, start the round |
| `leave` | graceful exit |

| Server → client | Meaning |
|---|---|
| `joined` | ack + room snapshot (roster, course, whether it's started) |
| `roster` | someone joined or left |
| `launch` | re-simulate this shot now |
| `shot` | score this (sent to everyone, including the sender) |
| `started` | lobby closed, build the game from this roster |
| `error` | bad secret, version mismatch, course mismatch, room started |

`protocolVersion` is checked on join and mismatches are rejected with a readable
message — two people on different builds is the expected failure mode.

---

## Where the code is

**Engine-side (`src/`)** — the part that would matter upstream:

| | |
|---|---|
| `src/net/types.ts` | wire protocol, shared with the server |
| `src/net/client.ts` | `NetClient` — transport only, reconnect with backoff, no game logic |
| `src/net/gameSync.ts` | wires `NetClient` ↔ `CourseGame` for scoring |
| `src/courses/game.ts` | shot-by-shot away/honors turn model, player ownership |
| `src/ui/UILobby.ts` | lobby: room, course pick, roster, start/leave, graphics |
| `server/` | the relay (own package.json, `ws` only) |

**Integration (`examples/`)** — how a page uses it:

| | |
|---|---|
| `examples/courses/courses.ts` | shot input, live re-simulation, lobby wiring |
| `examples/multiplayer/` | entry page that opens straight into the lobby |
| `examples/diagnostics/` | probe for running FUSE inside OGS Desktop |

**Tests** — 38, run in plain node with no browser, rapier or GPU. Includes two
independent `CourseGame`s driven only by their own `GameSync` through a real
relay, staying in sync across a full round.

---

## What's deliberately hacky (and why)

These exist only because we're standing in for OGS's own infrastructure. None
would survive contact with the real thing — upstream would do each properly.

- **The Multiplayer tile is injected into `/api/courses/home`** as it passes
  through our dev proxy. Desktop is closed-source and builds its library from
  that endpoint, so this was the only way to add an entry. Upstream would just
  add the catalog entry.
- **`/fuse/examples/...` path rewriting**, because Desktop launches
  `${app_url}/fuse/examples/<game>/index.html` and our dev root is `examples/`.
- **Proxying `/api` to `app.opengolfsim.com`**, because overriding `OGS_APP_URL`
  repoints sign-in, the library and the store as well as the game.

---

## Bugs found in existing FUSE code

Independent of multiplayer, and probably the most immediately useful part of
this work:

1. **`app.initialize()` never fires outside a plain browser.** `AppBridge`'s only
   `emit('ready')` sat at the end of `sendMessage`'s else-if chain, reachable
   only when `appType === 'web'`. Under `desktop`, `mobile` or `webapp` the
   message is posted to the host and the event never fires, so any
   `initialize()` callback waits forever. Invisible in a browser.
   *(`src/app.ts`, commit `5b6d3e4`)*

2. **Hole-out scored the wrong player.** In `applyShotResult`, the `isHoled`
   branch ran its finalizing `_addStrokes` *after* `_nextPlayer()`, so it wrote a
   spurious `0` hole-score for the *next* player — which `hasFinishedHole()` then
   treated as "finished", skipping them.
   *(`src/courses/game.ts`, commit `4f04866`)*

3. **Typing anywhere is gameplay.** `CourseKeyboardControls` listens on `window`
   in the capture phase, so every keystroke reaches the game regardless of focus:
   typing a room code with a digit in it fired a test shot, and single letters
   toggled stats, took a mulligan or went fullscreen.
   *(`src/controls.ts`, commit `018dfe4`)*

4. **A player with no clubs crashes the round.** `CoursePlayer` reads
   `player.clubs[0]`; a guest added in Desktop's player manager arrives with
   `clubs` undefined, and the round dies on the loading screen with
   `Cannot read properties of undefined (reading '0')`.
   *(`src/courses/player.ts`, commit `c3073d5`)*

5. **`Club` is missing fields Desktop actually sends** (`fullName`, `angle`), and
   `Player.clubs` is typed as required although a host app can omit it — which is
   how (4) went unnoticed.

**Open, not fixed:** trees render as black squares at Low quality. The first
theory (a batch material swap losing node properties under WebGPU) was wrong.
Current suspect: billboard materials set `alphaTest = 0` with
`alphaToCoverage = true`, and Low disables antialiasing, leaving no MSAA coverage
for it to act on.

---

## Known gaps

- **An intentional Leave is indistinguishable from a dropped connection.** The
  relay keeps the slot either way — right for a wifi blip, wrong for someone who
  left, since the turn still passes to them and the round stalls.
- **Live roster changes after the round starts are ignored** (a consequence of
  the same thing).
- **Only one FUSE course exists today.** Mountain Vista is the only `gameMode: 2`
  WebGL entry in the public catalog, so every round is played there. Not a
  multiplayer problem: OpenGolfSim's
  [Meshery](https://github.com/OpenGolfSim/course-meshery-tool) exports FUSE GLBs
  directly (`.GLB (Fuse)` is the only enabled format in its export dialog), so
  the pipeline exists and is moving independently of this work.

---

## Running it

See [HOSTING.md](./HOSTING.md) for the host and
[PLAYING-WITH-A-FRIEND.md](./PLAYING-WITH-A-FRIEND.md) for the guest. Short
version: the host runs `npm run host` and forwards TCP 5173 and 8080; the guest
launches OGS Desktop with `OGS_APP_URL` pointed at the host and needs no repo, no
node, and no matching OpenGolfSim version — they load the host's build, so both
ends run identical code by construction.

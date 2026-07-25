# Hosting a multiplayer round

You serve two things from one command: the **game build** (which the guest's
OpenGolfSim loads instead of the hosted one) and the **relay** (which carries
shots and roster between you).

Send your guest [PLAYING-WITH-A-FRIEND.md](./PLAYING-WITH-A-FRIEND.md) — it's
written for them and assumes nothing.

---

## Checklist

```
□ 1.  npm run host                    (builds, serves, starts the relay)
□ 2.  see a "Network:" line           (if not, nothing outside this machine can connect)
□ 3.  get your address                LAN: ipconfig getifaddr en0
                                      internet: curl -s ifconfig.me  + forward 5173 and 8080
□ 4.  quit OpenGolfSim completely     pkill -x OpenGolfSim
□ 5.  open --env OGS_APP_URL=http://localhost:5173 -a "/Applications/OpenGolfSim.app"
□ 6.  Multiplayer tile → pick course → room code → Join room
□ 7.  send guest: your IP, the room code, the secret (if you set one)
□ 8.  they appear in the roster → Start round
```

---

## 1. Start the server

```bash
cd ~/Documents/personalProjects/openGolfSim
npm run host
```

That builds the examples and serves them with the relay, listening on every
interface. Leave the terminal open — this is the server.

**With a room password** (optional on your own LAN, **not** optional when you
forward ports to the internet):

```bash
OGS_MP_SECRET='pick-something-long' npm run host
```

Without it, anyone who can reach the relay can join your room and inject shots.

### Check the output

```
Multiplayer relay: ws://localhost:8080
➜  Local:    http://localhost:5173/
➜  Network:  http://192.168.1.42:5173/     ← this line must be there
```

No `Network:` line means it's bound to localhost only and nobody else can reach
it — which looks exactly like a firewall problem, so check here first. (`npm run
host` passes `--host` for you; a bare `vite preview` does not.)

macOS may ask to allow incoming connections the first time. Allow it.

### If the relay didn't start

It says so loudly. Almost always another server still holding the port:

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

---

### What still needs the internet

The relay and the game build are entirely local — those work on an isolated LAN.
But **OpenGolfSim sign-in, the course library, and downloading a course you
haven't played before** all go to OpenGolfSim's servers *through your machine*.
So a working internet connection on the host is required in practice, even when
you and your guest are on the same wifi.

## 2. Find the address to give your guest

**Same network (LAN)** — nothing to forward:

```bash
ipconfig getifaddr en0     # wifi; try en1 or en6 if empty
```

**Over the internet:**

```bash
curl -s ifconfig.me
```

...and forward **both** ports to your machine, TCP:

| Port | What | Why the guest needs it |
|---|---|---|
| `5173` | the game build + OpenGolfSim API passthrough | their Desktop loads the game from here |
| `8080` | the relay (WebSocket) | shots and roster sync |

Two ports, not one. They're separate servers, and forgetting 8080 gives you a
game that loads but can't join anything.

---

## 3. Launch your own OpenGolfSim

```bash
pkill -x OpenGolfSim
open --env OGS_APP_URL=http://localhost:5173 -a "/Applications/OpenGolfSim.app"
```

Quit first — the variable is only read at startup. Use `open --env`, not the
binary directly: launching the executable from a terminal loses the app's
Bluetooth permission and your launch monitor won't connect.

You use `localhost`; only the guest needs your IP.

**Two local players in the garage:** add them in OpenGolfSim's player manager
*before* launching. They'll show under "Playing on this machine" and take turns
inside the normal rotation.

---

## 4. Open the room

1. **Multiplayer** tile in the library. It's injected by your own server, so it
   only appears while you're pointed at it — if it's missing, the override didn't
   take.
2. Pick the **course**. Whoever opens the room chooses; joiners inherit it, so
   your guest never has to match a course by hand.
3. Type a **room code** → **Join room**.

Send the IP, room code and secret. They'll appear in your roster. Either of you
can hit **Start round**.

---

## Rehearsing on your own LAN

Worth doing before involving anyone else. Same setup, no port forwarding.

1. `npm run host`, note the `Network:` address.
2. On a second machine on the same wifi, either:
   - **the full path** — install the beta and launch it with
     `OGS_APP_URL=http://<your-lan-ip>:5173`, or
   - **just a browser** — open `http://<your-lan-ip>:5173/multiplayer/index.html`.
     Exercises everything except a second launch monitor: joining, roster, turn
     order, live ball flight, scoring.

The browser version takes a minute and catches most problems.

---

## Shutting down

`Ctrl+C` in the server terminal stops the game server and the relay together. If
you forwarded ports to the internet, close them afterwards — while 5173 is open,
anyone who finds it can relay requests to `app.opengolfsim.com` through your
machine.

---

## When something's wrong

| Symptom | Where to look |
|---|---|
| Guest's library is empty, or they can't sign in | 5173 unreachable — no `Network:` line, or not forwarded. |
| Guest sees the game but can't join a room | 8080 unreachable. Separate port from 5173. |
| Your lobby says the relay is unreachable | The relay didn't start — check for something else on 8080. |
| No Multiplayer tile in your library | You're on the hosted app. Quit OpenGolfSim fully and relaunch with the override. |
| Guest gets "protocol version mismatch" | They aren't loading your build — their `OGS_APP_URL` didn't take. |
| `http proxy error: ... certificate has expired` | Your host machine can't reach the internet. A dropped connection or a router intercepting TLS reports as an expired certificate — it's almost never a real cert problem. Check `curl -s -o /dev/null -w '%{http_code}' https://example.com` and your clock (`date`). |
| Course list is empty in OpenGolfSim | Same cause. Sign-in, the library and first-time course downloads all go to OpenGolfSim's servers through your machine. The Multiplayer tile still appears, but a course you've never played can't download. |
| A player drops mid-round | Handled: they reconnect automatically, reclaim their slot, and the relay replays the shots they missed. Their corner pill reads "reconnecting…" meanwhile. The room survives 5 minutes with nobody connected. |
| A player **reloads** mid-round | Known gap. They rejoin the room but their scorecard restarts — only shots from the resume point onward are replayed. Restart the round. |
| "that round has already started" | A genuinely new player can't join mid-round (returning players are fine). Use a fresh room code. |

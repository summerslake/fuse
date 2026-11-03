# Hosting a multiplayer round

You serve two things from one command: the **game build** (which both
players' OpenGolfSim loads through its Custom Games tiles) and the **relay**
(which carries shots and roster between you).

Since OpenGolfSim 1.21 nobody launches it specially anymore: no `OGS_APP_URL`.
Each player installs two small tiles once, then opens OpenGolfSim normally.

Send your guest [PLAYING-WITH-A-FRIEND.md](./PLAYING-WITH-A-FRIEND.md) — it's
written for them and assumes nothing.

---

## Checklist

```
□ 1.  npm run host                    (builds, serves, starts the relay)
□ 2.  see a "Network:" line           (if not, nothing outside this machine can connect)
□ 3.  note the address                LAN: the "Network:" line above (that IS your LAN IP)
                                      internet: curl -s ifconfig.me  + forward 5173 and 8080
□ 4.  your tiles (once, and after adding a course):
        node scripts/install-desktop-launcher.mjs http://localhost:5173
□ 5.  open OpenGolfSim normally → Custom Games → Multiplayer
□ 6.  pick course → room code → Join room
□ 7.  send guest: the "Guest" install line (first time), the room code, the secret
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
➜  Local:   http://localhost:5173/
➜  Network: http://192.168.1.42:5173/      ← this line must be there
    You:    node scripts/install-desktop-launcher.mjs http://localhost:5173
            then open OpenGolfSim normally → Custom Games
    Guest (Mac Terminal, once):
      mkdir -p ~/Library/Application\ Support/opengolfsim-desktop/fuse && curl -fsSL http://203.0.113.7:5173/guest-tiles.tar | tar -xf - -C ~/Library/Application\ Support/opengolfsim-desktop/fuse
```

The **Guest** line is built from your public IP. Send it as-is to whoever is
joining over the internet; the Windows version is in
[PLAYING-WITH-A-FRIEND.md](./PLAYING-WITH-A-FRIEND.md). On a LAN, swap in the
**Network** address. Your server builds their tiles on the spot, pointed at
whatever address they reached you on, with your current course list. When a
guest installs them, this terminal logs a `[tiles]` line.

While you play, the relay logs each room to this terminal, so you can see who is
actually connected:

```
[room garage] created  —  course mtnvista-eztree-v3.glb
[room garage] joined: Lake  —  Lake
[room garage] joined: Brett  —  Lake, Brett
[room garage] round started (2 players)  —  Lake, Brett
[room garage] a player disconnected  —  Lake, Brett (away)
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

The relay, the game build and your local courses are served by you, so those
work on an isolated LAN. Each player's OpenGolfSim still talks to OpenGolfSim's
own servers for sign-in and its library, and a catalog course (Mountain Vista
and friends) downloads from them the first time it's played.

## 2. Find the address to give your guest

**Same network (LAN)** — nothing to forward. It's the `Network:` line the server
already printed; that's your LAN address, not a public one. If several are listed
(wifi plus ethernet, a VPN, Tailscale, Docker), use the one on the same subnet as
the other device — usually `192.168.x.x` or `10.x.x.x`.

Same value, if you'd rather ask directly:

```bash
ipconfig getifaddr en0     # wifi; try en1 or en6 if empty
```

It changes with the network you're on, so read it fresh each session.

**Over the internet:**

```bash
curl -s ifconfig.me
```

...and forward **both** ports to your machine, TCP:

| Port | What | Why the guest needs it |
|---|---|---|
| `5173` | the game build, your local courses, the tiles | their tiles load the game from here |
| `8080` | the relay (WebSocket) | shots and roster sync |

Two ports, not one. They're separate servers, and forgetting 8080 gives you a
game that loads but can't join anything.

---

## 3. Your own OpenGolfSim

Install your tiles once, and again whenever you add a course to
`courses.local.json`:

```bash
node scripts/install-desktop-launcher.mjs http://localhost:5173
```

That writes **Multiplayer** plus one tile per local course into OpenGolfSim's
Custom Games folder. Restart OpenGolfSim if it's open. Then just open it the
normal way. You use `localhost`; only the guest needs your IP.

**Two local players in the garage:** add them in OpenGolfSim's player manager
*before* launching. They'll show under "Playing on this machine" and take turns
inside the normal rotation.

The old route still works if you need it: launching with
`open --env OGS_APP_URL=http://localhost:5173 -a "/Applications/OpenGolfSim.app"`
puts the tiles under Courses instead, by routing all of OpenGolfSim's traffic
through your server. The diagnostics page (`OGS_DIAG=1`) needs it.

---

## 4. Open the room

1. **Custom Games** → **Multiplayer**. A local course's own tile goes straight
   into that course, with a Multiplayer button in the round.
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
   - **the full path**: OpenGolfSim 1.21+, then the guest install command from
     [PLAYING-WITH-A-FRIEND.md](./PLAYING-WITH-A-FRIEND.md) with your LAN IP, or
   - **just a browser** — open `http://<your-lan-ip>:5173/multiplayer/index.html`.
     Exercises everything except a second launch monitor: joining, roster, turn
     order, live ball flight, scoring.

The browser version takes a minute and catches most problems.

A plain LAN address isn't a "secure context" to a browser, unlike `localhost`, so
a few web APIs are missing there. Three falls back from WebGPU to WebGL by
itself, so it still renders, just possibly slower than what you see locally.
The same applies to a guest's OpenGolfSim loading your build through the tiles.

---

## Shutting down

`Ctrl+C` in the server terminal stops the game server and the relay together. If
you forwarded ports to the internet, close them afterwards: while 5173 is open,
anyone who finds it can load your build and courses, and relay requests to
`app.opengolfsim.com` through your machine.

---

## When something's wrong

| Symptom | Where to look |
|---|---|
| Guest's install command or tile can't reach you | 5173 unreachable: no `Network:` line, or not forwarded. |
| Guest sees the game but can't join a room | 8080 unreachable. Separate port from 5173. |
| Your lobby says the relay is unreachable | The relay didn't start — check for something else on 8080. |
| No Custom Games section | Tiles not installed, or OpenGolfSim older than 1.21. Run the installer, restart OpenGolfSim. |
| A new course has no tile | Re-run the installer (you) / the install command (guest). |
| OpenGolfSim won't quit on a Mac | Known OpenGolfSim bug (opengolfsim-desktop#6), not this setup. Force quit; nothing is lost. |
| `http proxy error: ... certificate has expired` | Your host machine can't reach the internet. A dropped connection or a router intercepting TLS reports as an expired certificate — it's almost never a real cert problem. Check `curl -s -o /dev/null -w '%{http_code}' https://example.com` and your clock (`date`). |
| Course list is empty in OpenGolfSim | Only with the old `OGS_APP_URL` route, where its traffic goes through your machine; same cause as the row above. |
| A player drops mid-round | Handled: they reconnect automatically, reclaim their slot, and the relay replays the shots they missed. Their corner pill reads "reconnecting…" meanwhile. The room survives 5 minutes with nobody connected. |
| A player **reloads** mid-round | Known gap. They rejoin the room but their scorecard restarts — only shots from the resume point onward are replayed. Restart the round. |
| "that round has already started" | A genuinely new player can't join mid-round (returning players are fine). Use a fresh room code. |

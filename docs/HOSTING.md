# Hosting a multiplayer round

What the host does, from a cold machine to a room your friend can join. The guest
side is a separate sheet you can send them: [PLAYING-WITH-A-FRIEND.md](./PLAYING-WITH-A-FRIEND.md).

You serve two things from one command: the **game build** (which the guest's
OpenGolfSim loads instead of the hosted one) and the **relay** (which carries
shots and roster between you).

---

## 1. Build and start the server

```bash
cd ~/Documents/personalProjects/openGolfSim
npm run build:examples
OGS_MP_SECRET='pick-something-long' npx vite preview --config vite.config.examples.js --host
```

Leave it running — this terminal is the server.

**`--host` is the flag everything depends on.** Without it Vite binds to
`localhost` only, and nobody else can reach the game no matter how the network is
set up. It fails in a way that looks like a firewall problem, so check the output:

```
Multiplayer relay: ws://localhost:8080
➜  Local:    http://localhost:5173/
➜  Network:  http://192.168.1.42:5173/     ← this line must be there
```

If there's no `Network:` line, `--host` didn't take.

`OGS_MP_SECRET` is the room password. Anyone who can reach the relay can
otherwise join your room and inject shots. Optional on a home LAN, **not optional**
when you forward ports to the internet.

> `npm run dev` also works and skips the build step, but serve the built bundle
> for a real round — it's what has been tested against Desktop.

### Confirm both ports are listening externally

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

You want `*:5173` and `*:8080`. If 5173 shows `[::1]:5173`, that's localhost only
— go back and add `--host`.

macOS may pop a firewall prompt the first time; allow incoming connections.

---

## 2. Find the address to give your friend

**On the same network (LAN):**

```bash
ipconfig getifaddr en0     # wifi; try en1 or en6 if that's empty
```

**Over the internet:**

```bash
curl -s ifconfig.me
```

...and forward **both** ports to your machine in your router: `5173` and `8080`,
both TCP. Two ports, not one — the game and the relay are separate servers.

---

## 3. Launch your own OpenGolfSim

```bash
open --env OGS_APP_URL=http://localhost:5173 -a "/Applications/OpenGolfSim.app"
```

Quit it completely first (⌘Q, or `pkill -x OpenGolfSim`) — the variable is only
read at startup. `open --env` matters: launching the binary directly loses the
app's Bluetooth permission and your launch monitor won't connect.

You use `localhost`; only the guest needs your IP.

---

## 4. Open the room

1. **Multiplayer** tile in the library (it's injected by your own server, so it
   only appears while you're pointed at it).
2. Pick the **course** — whoever opens the room chooses, and joiners inherit it.
3. Type a **room code**, then **Join room**.

Send your friend: the **IP**, the **room code**, and the **secret**. They'll
appear in your roster when they join. Either of you can hit **Start round**.

Two local players in the garage: add them in OpenGolfSim's player manager
*before* launching. They'll show under "Playing on this machine" and take turns
inside the normal rotation.

---

## Rehearsing on your own LAN

Worth doing before involving anyone else — same setup, no port forwarding.

1. Start the server with `--host` as above.
2. On a second machine on the same wifi, either:
   - **the full path** — install the beta and launch it with
     `OGS_APP_URL=http://<your-lan-ip>:5173`, or
   - **just a browser** — open `http://<your-lan-ip>:5173/multiplayer/index.html`.
     This exercises everything except a second launch monitor: joining, the
     roster, turn order, live ball flight, scoring.

The browser version is the fast one and catches most problems.

---

## Shutting down

`Ctrl+C` in the server terminal stops both the game server and the relay. If you
forwarded ports to the internet, close them — while 5173 is open, anyone who
finds it can relay requests to `app.opengolfsim.com` through your machine.

---

## When something's wrong

| Symptom | Where to look |
|---|---|
| Guest's library is empty, or can't sign in | 5173 unreachable — missing `--host`, or the port isn't forwarded. |
| Guest sees the game but can't join a room | 8080 unreachable. It's a separate port from 5173. |
| Your own lobby says the relay is unreachable | The relay didn't start. It fails loudly on startup — usually another server still holding 8080: `lsof -nP -iTCP:8080 -sTCP:LISTEN`. |
| Guest gets "protocol version mismatch" | They're not loading your build — their `OGS_APP_URL` didn't take. |
| No Multiplayer tile in your library | You're on the hosted app, not your server. Quit OpenGolfSim fully and relaunch with the override. |
| A player drops mid-round | They currently can't rejoin — the relay turns away joins to a started room. Everyone leaves and restarts the round. (Rejoin is a known gap.) |

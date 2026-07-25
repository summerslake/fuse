# Playing a round with a friend

Two people, two launch monitors, two houses, one round. One of you **hosts** (serves
the game and runs the relay); the other just launches OpenGolfSim pointed at the
host's address.

The guest does **not** need this repo, node, git, or a matching OpenGolfSim
version — they load the host's build over the network, so both ends run the same
code by construction and can never drift out of protocol sync.

---

## Host setup

### 1. Forward two ports

Both TCP, to the host machine:

| Port | What it is | Why the guest needs it |
|---|---|---|
| `5173` | the game (FUSE build + the OpenGolfSim API passthrough) | their Desktop loads the game from here |
| `8080` | the multiplayer relay (WebSocket) | shots and roster sync flow through here |

### 2. Start the server — with `--host`

```bash
npm run build:examples
OGS_MP_SECRET='pick-something-long' npx vite preview --config vite.config.examples.js --host
```

**`--host` is not optional.** Without it Vite binds to `localhost` only, and a
forwarded port reaches nothing. (The relay on 8080 already listens on all
interfaces.) You should see a `Network:` line in the output — that's the proof.

`OGS_MP_SECRET` is the room password. Without it, anyone who finds the port can
join the room and inject shots. Send it to your guest along with your IP.

### 3. Launch your own Desktop

```bash
open --env OGS_APP_URL=http://localhost:5173 -a "/Applications/OpenGolfSim.app"
```

Then **Multiplayer** in the library → pick the course → room code → **Join room**.

---

## Guest setup

Send them everything below, with the placeholders filled in:

- `<HOST-IP>` — the host's public IP
- `<ROOM>` — any short code you both agree on, e.g. `garage`
- `<SECRET>` — the value of `OGS_MP_SECRET`

### 1. Install the OpenGolfSim **beta**

The stable release may not include FUSE (the WebGL engine this runs on). The beta
tracks the `testing` channel. Ask the host for the exact installer link they used
— that guarantees you're on a build that can run it.

Set your launch monitor up in it as normal, and confirm a solo round works before
trying multiplayer. That isolates any hardware problem from any network problem.

### 2. Launch it pointed at the host

OpenGolfSim decides where to load the game from at startup, from an environment
variable. It has to be launched from a terminal so it can see that variable —
double-clicking the icon will not work.

#### macOS

```bash
open --env OGS_APP_URL=http://<HOST-IP>:5173 -a "/Applications/OpenGolfSim.app"
```

Quit OpenGolfSim completely first (⌘Q) if it's already running — the variable is
only read at startup.

#### Windows — PowerShell

```powershell
$env:OGS_APP_URL = "http://<HOST-IP>:5173"
& "$env:LOCALAPPDATA\Programs\OpenGolfSim\OpenGolfSim.exe"
```

#### Windows — Command Prompt

```cmd
set OGS_APP_URL=http://<HOST-IP>:5173
"%LOCALAPPDATA%\Programs\OpenGolfSim\OpenGolfSim.exe"
```

If that path is wrong: right-click the OpenGolfSim shortcut → **Properties** →
copy the **Target** field and use that path instead. Close OpenGolfSim fully
first (check the system tray).

### 3. Play

1. The library should load as normal — your account, your courses.
2. Click the **Multiplayer** tile.
3. Type the **room code** and the **secret**. The relay address is already filled
   in — it points back at the host automatically.
4. Click **Join room**. You'll see everyone who has joined.
5. Either player clicks **Start round**.

Whoever is farthest from the pin plays next, and you'll both watch every shot fly
in real time. **Leave** (top of the screen, under the yardage) drops you out.

---

## If it doesn't work

| Symptom | Cause |
|---|---|
| Library is empty / can't sign in | The host isn't running the server, or 5173 isn't forwarded. |
| Game loads, but joining fails | 8080 isn't forwarded. 5173 and 8080 are separate — both are needed. |
| "bad room secret" | The secret doesn't match `OGS_MP_SECRET`. |
| "protocol version mismatch" | You're not loading the host's build — check `OGS_APP_URL` really took. |
| "that round has already started" | They started without you. Pick a fresh room code and start again. |
| "courseUrl does not match the room" | Shouldn't happen — a joiner inherits the host's course. Tell the host. |
| Normal solo game, no Multiplayer tile | The override didn't take: OpenGolfSim was already running, or was launched by double-click instead of the terminal. |

---

## Two things the host should know

**Forwarding 5173 exposes an API passthrough.** That port proxies to
`app.opengolfsim.com` so the guest's library and sign-in work. While it's
forwarded, anyone who finds it can relay requests through your machine. Close the
port when you're not playing.

**The guest's OpenGolfSim login traffic routes through your machine.** Their
Desktop derives its whole API base from `app_url`, so their auth requests pass
through your proxy in transit. Fine between friends who know; worth saying out
loud.

**Both concerns go away with a private network** — Tailscale or similar between
the two machines, no public ports at all. Same commands, with the Tailscale
address in place of the public IP. Recommended if you play together often.

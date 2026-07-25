# Playing a round together

Two people, two launch monitors, two houses, one round. One of you **hosts**; the
other launches OpenGolfSim pointed at the host's address and joins.

The guest needs **no repo, no node, no git, and no particular OpenGolfSim
version** — they load the host's build over the network, so both ends run
identical code and can't drift out of sync.

Host setup lives in [HOSTING.md](./HOSTING.md). Everything below is the guest's
half — send it to them as-is, with the three placeholders filled in.

---

## Guest checklist

Your host will give you three things: **`<HOST-IP>`**, a **`<ROOM>`** code, and a
**`<SECRET>`** (maybe blank).

```
□ 1.  install the OpenGolfSim BETA        (the stable build may not include FUSE)
□ 2.  set your launch monitor up, confirm a normal solo round works
□ 3.  quit OpenGolfSim completely
□ 4.  launch it from a terminal with the host's address  (commands below)
□ 5.  library loads as normal → click the Multiplayer tile
□ 6.  type the room code + secret → Join room
□ 7.  wait for "Start round"
```

---

## 1. Install the beta

The stable release may not include FUSE, the WebGL engine this runs on. Ask your
host for the exact installer link they used — that guarantees a build that can
run it.

Set up your launch monitor and **play a normal solo round first.** If something
goes wrong later, this tells you it isn't your hardware.

## 2. Launch it pointed at the host

OpenGolfSim decides where to load the game from at startup, from an environment
variable — so it has to be launched from a terminal. **Double-clicking the icon
will not work**, and it has to be fully quit first (the variable is only read at
startup).

### macOS

```bash
open --env OGS_APP_URL=http://<HOST-IP>:5173 -a "/Applications/OpenGolfSim.app"
```

Quit first with ⌘Q, or `pkill -9 -f "OpenGolfSim.app"`.

### Windows — PowerShell

```powershell
$env:OGS_APP_URL = "http://<HOST-IP>:5173"
& "$env:LOCALAPPDATA\Programs\OpenGolfSim\OpenGolfSim.exe"
```

### Windows — Command Prompt

```cmd
set OGS_APP_URL=http://<HOST-IP>:5173
"%LOCALAPPDATA%\Programs\OpenGolfSim\OpenGolfSim.exe"
```

If that path is wrong: right-click the OpenGolfSim shortcut → **Properties** →
copy the **Target** field and use that instead. Make sure it's fully closed
first, including the system tray.

## 3. Join

1. The library loads as normal — your account, your courses.
2. Click the **Multiplayer** tile. If it isn't there, the override didn't take:
   OpenGolfSim was already running, or was started by double-click.
3. Type the **room code** and the **secret**. The relay address is already
   filled in — it points back at the host automatically.
4. **Join room.** You'll see everyone who has joined.
5. Either player hits **Start round**.

The course is whatever the host picked; you inherit it automatically.

## 4. Playing

Whoever is **farthest from the pin** plays next, and you both watch every shot
fly in real time. Shots are ignored when it isn't your turn, so a practice swing
won't wreck the scorecard.

The map shows everyone's ball. **Leave** — top of the screen, under the yardage —
drops you out.

If your connection blips, it reconnects on its own and catches you up on
anything you missed. The corner will say "reconnecting…" while it's working.

---

## If it doesn't work

| Symptom | Cause |
|---|---|
| No Multiplayer tile, just a normal game | The override didn't take — app was already running, or launched by double-click. |
| Library is empty / can't sign in | Can't reach the host's port 5173. Check the IP, and that they're running the server. |
| Game loads but joining fails | Can't reach port 8080. It's a separate port — the host needs both open. |
| "bad room secret" | The secret doesn't match. Watch for trailing spaces. |
| "protocol version mismatch" | You're not loading the host's build. Check `OGS_APP_URL`. |
| "that round has already started" | They started without you. Ask for a fresh room code. |
| Shots do nothing | It isn't your turn — the away player plays next. |

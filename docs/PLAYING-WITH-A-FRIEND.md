# Playing a round together

Two people, two launch monitors, two houses, one round. One of you **hosts**; the
other adds two tiles to OpenGolfSim once and joins from there.

The guest needs **no repo, no node and no git**, just OpenGolfSim 1.21 or newer.
The tiles load the game from the host's machine, so both ends run identical code
and can't drift out of sync.

Host setup lives in [HOSTING.md](./HOSTING.md). Everything below is the guest's
half. Send it to them as-is, with the placeholders filled in.

---

## Guest checklist

Your host will give you **`<HOST-IP>`**, a **`<ROOM>`** code, and maybe a
**`<SECRET>`**.

```
□ 1.  OpenGolfSim 1.21 or newer, launch monitor set up, a normal solo round works
□ 2.  install the tiles: one Terminal command        (once, below)
□ 3.  open OpenGolfSim normally → library → Custom Games → Multiplayer
□ 4.  type the room code (+ secret) → Join room
□ 5.  wait for "Start round"
```

---

## 1. Before anything else

Update OpenGolfSim to **1.21 or newer**; older versions don't have Custom Games.
Set up your launch monitor and **play a normal solo round first.** If something
goes wrong later, this tells you it isn't your hardware.

## 2. Install the tiles (once)

This adds **Multiplayer** and the host's own courses to your library, under
**Custom Games**. The host has to be running their server while you do this.

### macOS

Open **Terminal** (Spotlight → "Terminal"), paste this as one line, press Return:

```bash
mkdir -p ~/Library/Application\ Support/opengolfsim-desktop/fuse && curl -fsSL http://<HOST-IP>:5173/guest-tiles.tar | tar -xf - -C ~/Library/Application\ Support/opengolfsim-desktop/fuse
```

It prints nothing when it works. Nothing gets downloaded through a browser, so
there's no "can't verify this app" warning, and nothing to double-click.

### Windows

Open **Command Prompt** (Start → "cmd"), paste this as one line, press Enter:

```cmd
mkdir "%APPDATA%\opengolfsim-desktop\fuse" 2>nul & curl -fsSL http://<HOST-IP>:5173/guest-tiles.tar | tar -xf - -C "%APPDATA%\opengolfsim-desktop\fuse"
```

(Not yet tried on a Windows machine. If the tiles don't show up, check that
`%APPDATA%\opengolfsim-desktop` exists; it's where OpenGolfSim keeps its data.)

**Run it again** whenever the host adds a course or their IP changes. It
replaces the old tiles.

**If you used the old setup** (a launcher script, or a Terminal command with
`OGS_APP_URL`): you don't need it anymore. Delete the launcher, and open
OpenGolfSim the normal way.

## 3. Join

1. Open OpenGolfSim normally. Your library is unchanged: your account, your
   courses.
2. Scroll to the bottom: **Custom Games** → **Multiplayer** → Play.
3. Type the **room code** and the **secret**. The relay address is already
   filled in; it points back at the host automatically.
4. **Join room.** You'll see everyone who has joined.
5. Either player hits **Start round**.

The course is whatever the host picked; you inherit it automatically.

## 4. Playing

Whoever is **farthest from the pin** plays next, and you both watch every shot
fly in real time. Shots are ignored when it isn't your turn, so a practice swing
won't wreck the scorecard.

The map shows everyone's ball. **Leave** (top of the screen, under the yardage)
drops you out.

If your connection blips, it reconnects on its own and catches you up on
anything you missed. The corner will say "reconnecting…" while it's working.

---

## If it doesn't work

| Symptom | Cause |
|---|---|
| The install command fails (`curl: (7)` or `(28)`) | Can't reach the host's port 5173. Check the IP, and that they're running the server. |
| No Custom Games section | The tiles aren't in the right folder, or OpenGolfSim is older than 1.21. Restart it after installing. |
| Tile says it can't reach the host | Same as the first row: the host's server isn't running, or 5173 isn't forwarded. |
| Game loads but joining fails | Can't reach port 8080. It's a separate port; the host needs both open. |
| "bad room secret" | The secret doesn't match. Watch for trailing spaces. |
| "protocol version mismatch" | Stale tab or cached page. Exit the round and click the tile again. |
| "that round has already started" | They started without you. Ask for a fresh room code. |
| Shots do nothing | It isn't your turn; the away player plays next. |
| OpenGolfSim won't quit (Mac) | Known OpenGolfSim bug, not this setup. Force quit (⌥⌘⎋); nothing is lost. |

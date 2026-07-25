/**
 * A single multiplayer room: the authoritative roster for one game. Holds the
 * connected clients' sockets so it can broadcast. No protocol parsing or auth
 * here — relay.js does that and calls into this.
 *
 * The room deliberately knows nothing about turns or scoring: turn order is
 * derived identically on every client from the shot results themselves (see
 * CourseGame's "away" model), so there is nothing here to arbitrate.
 */
export class Room {
  /**
   * @param {string} code       room code (join key)
   * @param {string} courseUrl  GLB url; first joiner sets it, others must match
   */
  constructor(code, courseUrl = '') {
    this.code = code;
    this.courseUrl = courseUrl;
    /** @type {Map<string, { socket: any, playerIds: string[], alive: boolean, clientKey: string }>} */
    this.clients = new Map();
    /** roster order === honors order off the tee. Player + ownerId, id namespaced. */
    this.roster = [];
    /** true once someone has hit Start; late joiners are turned away */
    this.started = false;
    /**
     * Every shot broadcast in this room, in order. A client that drops and comes
     * back replays what it missed from here — otherwise its scorecard and turn
     * order diverge from everyone else's, silently.
     */
    this.shotLog = [];
  }

  /**
   * Register a client and append its players to the roster. Player ids are
   * namespaced as `${clientId}:${originalId}` so two clients that both use
   * `player-1` (dev) don't collide. See MULTIPLAYER_PLAN "Player IDs".
   */
  addClient(clientId, socket, players, clientKey = '') {
    const entries = players.map((p) => ({
      ...p,
      id: `${clientId}:${p.id}`,
      ownerId: clientId,
    }));
    this.clients.set(clientId, {
      socket,
      playerIds: entries.map((e) => e.id),
      alive: true,
      clientKey,
    });
    this.roster.push(...entries);
    return entries;
  }

  /** The client holding this key, whether or not it's currently connected. */
  findByKey(clientKey) {
    if (!clientKey) return undefined;
    for (const [clientId, client] of this.clients) {
      if (client.clientKey === clientKey) return { clientId, client };
    }
    return undefined;
  }

  /**
   * Reattach a returning client to its existing slot: same clientId, same roster
   * entries, new socket. The roster never changes, so every other client's game
   * — which was built around those exact player ids — stays valid.
   */
  resumeClient(clientId, socket) {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.socket = socket;
    client.alive = true;
    return true;
  }

  /**
   * A client's socket closed. Once the round is under way its players stay in
   * the roster — every other client is mid-round with those ids baked in, and
   * the player may be seconds away from reconnecting. In the lobby, where
   * nothing is built yet, drop them so the roster reflects who's actually there.
   */
  removeClient(clientId) {
    const client = this.clients.get(clientId);
    if (this.started && client) {
      client.alive = false;
      return;
    }
    this.clients.delete(clientId);
    this.roster = this.roster.filter((p) => p.ownerId !== clientId);
  }

  /** Connected clients only — a disconnected slot is still in `clients`. */
  get liveClientCount() {
    let count = 0;
    for (const client of this.clients.values()) if (client.alive) count++;
    return count;
  }

  ownsPlayer(clientId, playerId) {
    const c = this.clients.get(clientId);
    return !!c && c.playerIds.includes(playerId);
  }

  snapshot() {
    return {
      code: this.code,
      courseUrl: this.courseUrl,
      roster: this.roster,
      started: this.started,
    };
  }

  rosterMessage() {
    return {
      type: 'roster',
      roster: this.roster,
      started: this.started,
    };
  }

  broadcast(msg) {
    if (msg.type === 'shot') this.shotLog.push(msg);
    const raw = JSON.stringify(msg);
    for (const { socket, alive } of this.clients.values()) {
      if (alive && socket.readyState === 1 /* OPEN */) socket.send(raw);
    }
  }
}

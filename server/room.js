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
    /** @type {Map<string, { socket: any, playerIds: string[], alive: boolean }>} */
    this.clients = new Map();
    /** roster order === honors order off the tee. Player + ownerId, id namespaced. */
    this.roster = [];
    /** true once someone has hit Start; late joiners are turned away */
    this.started = false;
  }

  /**
   * Register a client and append its players to the roster. Player ids are
   * namespaced as `${clientId}:${originalId}` so two clients that both use
   * `player-1` (dev) don't collide. See MULTIPLAYER_PLAN "Player IDs".
   */
  addClient(clientId, socket, players) {
    const entries = players.map((p) => ({
      ...p,
      id: `${clientId}:${p.id}`,
      ownerId: clientId,
    }));
    this.clients.set(clientId, {
      socket,
      playerIds: entries.map((e) => e.id),
      alive: true,
    });
    this.roster.push(...entries);
    return entries;
  }

  removeClient(clientId) {
    this.clients.delete(clientId);
    this.roster = this.roster.filter((p) => p.ownerId !== clientId);
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
    const raw = JSON.stringify(msg);
    for (const { socket } of this.clients.values()) {
      if (socket.readyState === 1 /* OPEN */) socket.send(raw);
    }
  }
}

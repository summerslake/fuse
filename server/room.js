/**
 * A single multiplayer room: the authoritative roster and turn state for one
 * game. Holds the connected clients' sockets so it can broadcast. No protocol
 * parsing or auth here — relay.js does that and calls into this.
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
    /** roster order === turn order. Each entry is a Player + ownerId, id namespaced. */
    this.roster = [];
    this.currentPlayerIndex = 0;
    this.currentHoleNumber = 1;
    /** set of `${playerId}@${holeNumber}` for players who have finished a hole */
    this.finished = new Set();
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
    // keep the turn index in range after someone leaves
    if (this.currentPlayerIndex >= this.roster.length) {
      this.currentPlayerIndex = 0;
    }
  }

  ownsPlayer(clientId, playerId) {
    const c = this.clients.get(clientId);
    return !!c && c.playerIds.includes(playerId);
  }

  hasFinishedHole(playerId, holeNumber) {
    return this.finished.has(`${playerId}@${holeNumber}`);
  }

  markHoleComplete(playerId, holeNumber) {
    this.finished.add(`${playerId}@${holeNumber}`);
  }

  allFinishedHole(holeNumber) {
    return (
      this.roster.length > 0 &&
      this.roster.every((p) => this.hasFinishedHole(p.id, holeNumber))
    );
  }

  /**
   * Advance to the next player who hasn't finished the current hole. Port of
   * CourseGame's #findNextPlayerUp / _nextPlayer (game.ts). When everyone has
   * finished the hole, move to the next hole and back to the first player.
   *
   * NOTE (Phase 1): next-hole is a simple increment. Real hole sequencing
   * (non-contiguous numbers, round-end) is refined in Phase 3 when the server
   * is wired to CourseGame's ordered hole list.
   *
   * @returns {{ playerId: string|null, holeNumber: string }}
   */
  advanceTurn() {
    const n = this.roster.length;
    const hole = String(this.currentHoleNumber);
    if (n === 0) return { playerId: null, holeNumber: hole };

    for (let i = 1; i <= n; i++) {
      const idx = (this.currentPlayerIndex + i) % n;
      if (!this.hasFinishedHole(this.roster[idx].id, hole)) {
        this.currentPlayerIndex = idx;
        return { playerId: this.roster[idx].id, holeNumber: hole };
      }
    }

    // everyone finished this hole -> next hole, first player
    this.currentHoleNumber += 1;
    this.currentPlayerIndex = 0;
    return {
      playerId: this.roster[0].id,
      holeNumber: String(this.currentHoleNumber),
    };
  }

  snapshot() {
    return {
      code: this.code,
      courseUrl: this.courseUrl,
      roster: this.roster,
      currentPlayerIndex: this.currentPlayerIndex,
      currentHoleNumber: this.currentHoleNumber,
    };
  }

  rosterMessage() {
    return {
      type: 'roster',
      roster: this.roster,
      currentPlayerIndex: this.currentPlayerIndex,
      currentHoleNumber: this.currentHoleNumber,
    };
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const { socket } of this.clients.values()) {
      if (socket.readyState === 1 /* OPEN */) socket.send(raw);
    }
  }
}

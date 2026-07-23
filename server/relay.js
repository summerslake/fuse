import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';

/**
 * Bump when the message shapes change. Keep in sync with src/net/types.ts.
 * Clients on a different version are rejected on join with a readable error.
 */
export const PROTOCOL_VERSION = 1;

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_CLIENTS_PER_ROOM = 8;

/**
 * Create (but don't own the lifecycle beyond close) a relay server. Importable
 * with no side effects — used both by the standalone entry (index.js) and the
 * in-process vite plugin.
 *
 * @param {{ port?: number, host?: string, secret?: string }} opts
 * @returns {{ wss: WebSocketServer, port: number, rooms: Map<string, Room>, ready: Promise<void>, close: () => Promise<void> }}
 */
export function createRelay({ port = 8080, host, secret = '' } = {}) {
  const wss = new WebSocketServer({ port, host, maxPayload: MAX_MESSAGE_BYTES });
  /** @type {Map<string, Room>} */
  const rooms = new Map();
  let nextClientId = 1;

  const ready = new Promise((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });

  wss.on('connection', (socket) => {
    const conn = { clientId: null, roomCode: null, joined: false };
    socket.on('message', (data) => handleMessage(socket, conn, data));
    socket.on('close', () => handleClose(conn));
    socket.on('error', () => {}); // never let a socket error crash the server
  });

  function send(socket, msg) {
    if (socket.readyState === 1 /* OPEN */) socket.send(JSON.stringify(msg));
  }

  function handleMessage(socket, conn, data) {
    let msg;
    try {
      msg = JSON.parse(data.toString('utf-8'));
    } catch {
      return; // ignore garbage; never throw
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') return handleJoin(socket, conn, msg);

    // Everything else requires a completed join.
    if (!conn.joined) return;
    const room = rooms.get(conn.roomCode);
    if (!room) return;

    switch (msg.type) {
      case 'shot_result': {
        // reject shots for players this client doesn't own
        if (!room.ownsPlayer(conn.clientId, msg.playerId)) return;
        room.broadcast({ type: 'shot', playerId: msg.playerId, result: msg.result });
        break;
      }
      case 'hole_complete': {
        if (!room.ownsPlayer(conn.clientId, msg.playerId)) return;
        room.markHoleComplete(msg.playerId, msg.holeNumber);
        const turn = room.advanceTurn();
        room.broadcast({ type: 'turn', playerId: turn.playerId, holeNumber: turn.holeNumber });
        break;
      }
      case 'leave': {
        socket.close();
        break;
      }
    }
  }

  function handleJoin(socket, conn, msg) {
    if (conn.joined) return; // already joined; ignore

    // Version + secret first, before any other work.
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      send(socket, {
        type: 'error',
        message: `protocol version mismatch (server ${PROTOCOL_VERSION}, client ${msg.protocolVersion}). Both machines must run the same build.`,
      });
      return;
    }
    if (!safeEqual(msg.roomSecret ?? '', secret)) {
      send(socket, { type: 'error', message: 'bad room secret' });
      return;
    }
    if (typeof msg.roomCode !== 'string' || !Array.isArray(msg.players)) {
      send(socket, { type: 'error', message: 'malformed join' });
      return;
    }

    let room = rooms.get(msg.roomCode);
    if (!room) {
      room = new Room(msg.roomCode, msg.courseUrl ?? '');
      rooms.set(msg.roomCode, room);
    } else if (msg.courseUrl && room.courseUrl && msg.courseUrl !== room.courseUrl) {
      send(socket, {
        type: 'error',
        message: 'courseUrl does not match the room (everyone must load the same course)',
      });
      return;
    }
    if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
      send(socket, { type: 'error', message: 'room is full' });
      return;
    }

    const clientId = `c${nextClientId++}`;
    conn.clientId = clientId;
    conn.roomCode = msg.roomCode;
    conn.joined = true;
    room.addClient(clientId, socket, msg.players);

    send(socket, { type: 'joined', clientId, room: room.snapshot() });
    room.broadcast(room.rosterMessage());
  }

  function handleClose(conn) {
    if (!conn.joined) return;
    const room = rooms.get(conn.roomCode);
    if (!room) return;
    room.removeClient(conn.clientId);
    if (room.clients.size === 0) {
      rooms.delete(conn.roomCode);
      return;
    }
    room.broadcast(room.rosterMessage());
  }

  return {
    wss,
    port,
    rooms,
    ready,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  };
}

/** Constant-time string compare that doesn't leak length via early return. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // compare against self so timing doesn't depend on the mismatch
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

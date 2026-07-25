import EventEmitter from 'eventemitter3';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type JoinedMessage,
  type RosterMessage,
  type ShotMessage,
  type LaunchMessage,
  type StartedMessage,
  type NetShotResult,
  type NetShotLaunch,
} from './types';

export interface NetClientJoinParams {
  roomCode: string;
  roomSecret?: string;
  courseUrl: string;
  players: OpenGolfSim.Player[];
  /**
   * Stable identity across reconnects. Defaults to a value persisted in
   * localStorage, so a reconnect (or a reload) reclaims this client's slot and
   * its player ids instead of arriving as a stranger.
   */
  clientKey?: string;
}

const CLIENT_KEY_STORAGE = 'ogs.net.clientKey';

/**
 * `crypto.randomUUID` only exists in a secure context, and a remote player loads
 * the host's build from a plain LAN or public address — so it is exactly missing
 * in the case this key matters most. Fall back to something unique enough: it
 * only has to distinguish clients within one room.
 */
function randomKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** This browser's stable client key, generated once and remembered. */
function persistentClientKey(): string {
  try {
    const existing = localStorage.getItem(CLIENT_KEY_STORAGE);
    if (existing) return existing;
    const created = randomKey();
    localStorage.setItem(CLIENT_KEY_STORAGE, created);
    return created;
  } catch {
    // private mode: a per-session key still survives reconnects, just not reloads
    return randomKey();
  }
}

interface NetClientEvents {
  /** socket opened and join sent */
  open: () => void;
  joined: (msg: JoinedMessage) => void;
  roster: (msg: RosterMessage) => void;
  shot: (msg: ShotMessage) => void;
  /** a player just swung — fly the same shot live (re-simulate) */
  launch: (msg: LaunchMessage) => void;
  /** the lobby closed — the roster is final, build the game from it */
  started: (msg: StartedMessage) => void;
  /** server-sent error (bad secret, version mismatch, courseUrl mismatch, …) */
  error: (message: string) => void;
  /** socket closed (a reconnect may follow unless close()/leave() was called) */
  close: () => void;
}

/**
 * Thin browser-side transport to the relay. Mirrors AppBridge's style
 * (eventemitter3 + typed events). Deliberately dumb: connection lifecycle,
 * JSON framing, reconnect-with-backoff, and event emission — NO game logic.
 * The game layer (Phase 3) listens to these events and drives CourseGame.
 */
export class NetClient extends EventEmitter<NetClientEvents> {
  url: string;
  clientId?: string;
  /** Shots applied so far — what the relay replays from after a reconnect. */
  shotsSeen = 0;
  readonly clientKey: string;
  #join: NetClientJoinParams;
  #ws?: WebSocket;
  #closedByUser = false;
  #backoff = 500;
  readonly #maxBackoff = 5000;
  #reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(url: string, join: NetClientJoinParams) {
    super();
    this.url = url;
    this.#join = join;
    this.clientKey = join.clientKey ?? persistentClientKey();
  }

  connect() {
    this.#closedByUser = false;
    const ws = new WebSocket(this.url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#backoff = 500; // reset backoff on a successful connect
      this.#send({
        type: 'join',
        protocolVersion: PROTOCOL_VERSION,
        roomCode: this.#join.roomCode,
        roomSecret: this.#join.roomSecret ?? '',
        courseUrl: this.#join.courseUrl,
        players: this.#join.players,
        clientKey: this.clientKey,
        sinceShot: this.shotsSeen,
      });
      this.emit('open');
    });

    ws.addEventListener('message', (ev) => this.#onMessage(ev));

    ws.addEventListener('close', () => {
      this.emit('close');
      if (!this.#closedByUser) this.#scheduleReconnect();
    });

    // 'error' is always followed by 'close'; let close() handle reconnect.
    ws.addEventListener('error', () => {});
  }

  #onMessage(ev: MessageEvent) {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch {
      return;
    }
    switch (msg.type) {
      case 'joined':
        this.clientId = msg.clientId;
        this.emit('joined', msg);
        break;
      case 'roster':
        this.emit('roster', msg);
        break;
      case 'shot':
        // counted, not just forwarded: this is the resume point the relay
        // replays from, so it has to track what we've actually been handed
        this.shotsSeen++;
        this.emit('shot', msg);
        break;
      case 'launch':
        this.emit('launch', msg);
        break;
      case 'started':
        this.emit('started', msg);
        break;
      case 'error':
        // every server error is fatal to this join (bad secret, version
        // mismatch, room started…) — retrying would just loop on it
        this.#closedByUser = true;
        clearTimeout(this.#reconnectTimer);
        this.emit('error', msg.message);
        break;
    }
  }

  #scheduleReconnect() {
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, this.#maxBackoff);
    this.#reconnectTimer = setTimeout(() => {
      if (!this.#closedByUser) this.connect();
    }, delay);
  }

  #send(msg: ClientMessage) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(msg));
    }
  }

  sendShotResult(playerId: string, result: NetShotResult) {
    this.#send({ type: 'shot_result', playerId, result });
  }

  /** Announce a swing so other clients can fly it live (before it lands). */
  sendShotLaunch(playerId: string, launch: NetShotLaunch) {
    this.#send({ type: 'shot_launch', playerId, launch });
  }

  /** Close the lobby and start the round for everyone in the room. */
  sendStart() {
    this.#send({ type: 'start' });
  }

  /** Graceful exit: tell the server, close, and don't reconnect. */
  leave() {
    this.#closedByUser = true;
    clearTimeout(this.#reconnectTimer);
    this.#send({ type: 'leave' });
    this.#ws?.close();
  }

  /** Close without a leave message and don't reconnect. */
  close() {
    this.#closedByUser = true;
    clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
  }
}

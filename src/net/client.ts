import EventEmitter from 'eventemitter3';
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type JoinedMessage,
  type RosterMessage,
  type ShotMessage,
  type LaunchMessage,
  type TurnMessage,
  type NetShotResult,
  type NetShotLaunch,
} from './types';

export interface NetClientJoinParams {
  roomCode: string;
  roomSecret?: string;
  courseUrl: string;
  players: OpenGolfSim.Player[];
}

interface NetClientEvents {
  /** socket opened and join sent */
  open: () => void;
  joined: (msg: JoinedMessage) => void;
  roster: (msg: RosterMessage) => void;
  shot: (msg: ShotMessage) => void;
  /** a player just swung — fly the same shot live (re-simulate) */
  launch: (msg: LaunchMessage) => void;
  turn: (msg: TurnMessage) => void;
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
        this.emit('shot', msg);
        break;
      case 'launch':
        this.emit('launch', msg);
        break;
      case 'turn':
        this.emit('turn', msg);
        break;
      case 'error':
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

  sendHoleComplete(playerId: string, holeNumber: string, strokes: number) {
    this.#send({ type: 'hole_complete', playerId, holeNumber, strokes });
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

/**
 * Wire protocol for FUSE remote multiplayer, shared shape between the browser
 * NetClient and the relay server. The server mirrors these as plain JS.
 *
 * Keep PROTOCOL_VERSION in sync with server/relay.js.
 */

export const PROTOCOL_VERSION = 1;

/** A roster player as the server tracks it: a Player with a namespaced id + owner. */
export interface RosterPlayer {
  name: string;
  /** namespaced as `${ownerId}:${originalId}` — globally unique across clients */
  id: string;
  clubs: OpenGolfSim.Club[];
  ownerId: string;
}

export interface RoomSnapshot {
  code: string;
  courseUrl: string;
  roster: RosterPlayer[];
  currentPlayerIndex: number;
  currentHoleNumber: number;
}

/**
 * Payload of a completed shot sent across the wire. Refined in Phase 4 (ghost
 * balls) — kept loose for now so Phase 1/3 don't over-commit the shape.
 */
export type NetShotResult = Record<string, unknown>;

// ---- client -> server ----

export interface JoinMessage {
  type: 'join';
  protocolVersion: number;
  roomCode: string;
  roomSecret: string;
  courseUrl: string;
  players: OpenGolfSim.Player[];
}
export interface ShotResultMessage {
  type: 'shot_result';
  playerId: string;
  result: NetShotResult;
}
export interface HoleCompleteMessage {
  type: 'hole_complete';
  playerId: string;
  holeNumber: string;
  strokes: number;
}
export interface LeaveMessage {
  type: 'leave';
}
export type ClientMessage =
  | JoinMessage
  | ShotResultMessage
  | HoleCompleteMessage
  | LeaveMessage;

// ---- server -> client ----

export interface JoinedMessage {
  type: 'joined';
  clientId: string;
  room: RoomSnapshot;
}
export interface RosterMessage {
  type: 'roster';
  roster: RosterPlayer[];
  currentPlayerIndex: number;
  currentHoleNumber: number;
}
export interface ShotMessage {
  type: 'shot';
  playerId: string;
  result: NetShotResult;
}
export interface TurnMessage {
  type: 'turn';
  playerId: string | null;
  holeNumber: string;
}
export interface ErrorMessage {
  type: 'error';
  message: string;
}
export type ServerMessage =
  | JoinedMessage
  | RosterMessage
  | ShotMessage
  | TurnMessage
  | ErrorMessage;

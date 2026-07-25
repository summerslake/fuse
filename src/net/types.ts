/**
 * Wire protocol for FUSE remote multiplayer, shared shape between the browser
 * NetClient and the relay server. The server mirrors these as plain JS.
 *
 * Keep PROTOCOL_VERSION in sync with server/relay.js.
 */

export const PROTOCOL_VERSION = 2;

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
 * Payload of a completed shot sent across the wire — enough to score it on every
 * client. The visible flight is reproduced separately from the launch params
 * (see NetShotLaunch), so this only needs the resting state for scoring.
 */
export interface NetShotResult {
  /** ball resting position [x, y, z] */
  endPosition: [number, number, number];
  /** surface the ball came to rest on; only `type` is needed for scoring */
  surface?: { type?: string };
  isHoled: boolean;
}

/**
 * Sent the instant a player swings, so every other client can fly the same shot
 * live (re-simulate the physics) instead of waiting for it to land. Purely
 * visual — scoring still comes from the authoritative NetShotResult on rest.
 */
export interface NetShotLaunch {
  /** the launch-monitor shot to reproduce */
  shot: OpenGolfSim.Shot;
  /** the shooter's ball position [x, y, z] */
  start: [number, number, number];
  /** the shooter's aim point [x, y, z] (sets the ball's direction) */
  aim: [number, number, number];
}

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
export interface ShotLaunchMessage {
  type: 'shot_launch';
  playerId: string;
  launch: NetShotLaunch;
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
  | ShotLaunchMessage
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
export interface LaunchMessage {
  type: 'launch';
  playerId: string;
  launch: NetShotLaunch;
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
  | LaunchMessage
  | TurnMessage
  | ErrorMessage;

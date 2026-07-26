/**
 * Wire protocol for FUSE remote multiplayer, shared shape between the browser
 * NetClient and the relay server. The server mirrors these as plain JS.
 *
 * Keep PROTOCOL_VERSION in sync with server/relay.js.
 */
import { type HazardAction } from '@/courses/game';

export const PROTOCOL_VERSION = 5;

export { type HazardAction };

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
  /** true once the round is under way (the roster is frozen) */
  started: boolean;
}

/**
 * Payload of a completed shot sent across the wire — enough to score it on every
 * client. The visible flight is reproduced separately from the launch params
 * (see NetShotLaunch), so this only needs the resting state for scoring.
 */
export interface NetShotResult {
  /** ball resting position [x, y, z] */
  endPosition: [number, number, number];
  /** surface type the ball came to rest on, e.g. 'green' — that's all scoring reads */
  surface?: string;
  isHoled: boolean;
  /** ball finished in water: the shooter owes a HazardMessage before play continues */
  isInWater?: boolean;
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
  /**
   * Stable per-client identity, kept across reconnects. A returning client
   * reclaims its old clientId and its roster entries — which matters because
   * player ids are namespaced by clientId and every client's game was built
   * around them. Without it, a dropped connection is the end of the round.
   */
  clientKey: string;
  /**
   * How many shots this client has already applied. On a resume the relay
   * replays everything after this, so a client that missed shots while offline
   * catches up instead of silently diverging.
   */
  sinceShot?: number;
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
/**
 * How the shooter chose to play a ball that finished in water. Only the choice
 * travels — where the drop lands is recomputed identically on every client (see
 * CourseGame.applyHazardAction), the same way turn order already is.
 */
export interface HazardActionMessage {
  type: 'hazard_action';
  playerId: string;
  action: HazardAction;
}
/** Close the lobby and start the round for everyone. Any client may send it. */
export interface StartMessage {
  type: 'start';
}
export interface LeaveMessage {
  type: 'leave';
}
export type ClientMessage =
  | JoinMessage
  | ShotResultMessage
  | ShotLaunchMessage
  | HazardActionMessage
  | StartMessage
  | LeaveMessage;

// ---- server -> client ----

export interface JoinedMessage {
  type: 'joined';
  clientId: string;
  room: RoomSnapshot;
  /** true when this reclaimed an existing slot rather than taking a new one */
  resumed?: boolean;
}
export interface RosterMessage {
  type: 'roster';
  roster: RosterPlayer[];
  started: boolean;
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
/** A hazard resolution, echoed to everyone. Ordered in the log alongside shots. */
export interface HazardMessage {
  type: 'hazard';
  playerId: string;
  action: HazardAction;
}
/** The lobby closed — build the game from this (now frozen) roster. */
export interface StartedMessage {
  type: 'started';
  roster: RosterPlayer[];
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
  | HazardMessage
  | StartedMessage
  | ErrorMessage;

/**
 * The messages that change game state, in the order they must be applied. Both
 * go in the room's log and both count toward `sinceShot`, because replaying
 * shots without the hazard resolutions between them rebuilds a different round.
 */
export type GameEventMessage = ShotMessage | HazardMessage;

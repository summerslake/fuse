import * as THREE from 'three';
import EventEmitter from 'eventemitter3';
import { type CourseGame, type HazardAction } from '@/courses/game';
import { type CourseColliderType } from '@/courses/surfaces';
import { type GolfBall } from '@/objects/golfBall';
import { type NetClient } from './client';
import { type ShotMessage, type HazardMessage } from './types';

/**
 * Wires a networked CourseGame to a NetClient for SCORING (the authoritative
 * path). Testable without a browser:
 *
 *   local ball stops ─▶ sendShotResult ─▶ [server] ─▶ 'shot' to everyone
 *                                                         │
 *   every client: applyShotResult ◀───────────────────────┘
 *
 * The local shot is applied via the server echo too — one code path for local
 * and remote shots. Turn order is NOT sent over the wire: `applyShotResult`
 * advances it deterministically (shot-by-shot, "away" plays next) from data
 * every client already has, so all clients stay in sync without server turn
 * arbitration.
 *
 * The VISIBLE flight is handled separately (see the 'launch' wiring in the
 * course example): a swing is broadcast at launch so every client re-simulates
 * the shot live. This class only cares about the resting result + score. The
 * CourseGame must be constructed with `networked: true` so its built-in
 * shotEnded adapter is off.
 */
export interface GameSyncOptions {
  /**
   * Returns true when the ball's current shot is a REPLAY of a remote player's
   * swing (re-simulated locally so we can watch it), not a real local shot. Such
   * a shot must never be sent as our own result — otherwise, if the turn has
   * already flipped to us by the time the replay lands, we'd wrongly report the
   * remote player's landing spot as our own shot.
   */
  isReplay?: () => boolean;
}

export interface GameSyncEvents {
  /**
   * A ball finished in the water. The turn is parked on `playerId` until they
   * choose; `isLocal` says whether that choice is ours to make (i.e. whether to
   * put the hazard dialog up on this screen).
   */
  hazard: (playerId: string, isLocal: boolean) => void;
}

export class GameSync extends EventEmitter<GameSyncEvents> {
  #game: CourseGame;
  #net: NetClient;

  constructor(game: CourseGame, net: NetClient, golfBall: GolfBall, opts: GameSyncOptions = {}) {
    super();
    this.#game = game;
    this.#net = net;

    // 1. Local ball came to rest -> send the authoritative result (don't apply
    //    locally). Only for a real shot by a player we own whose turn it is —
    //    never for a re-simulated remote shot (see GameSyncOptions.isReplay).
    golfBall.on('shotEnded', (details) => {
      if (opts.isReplay?.()) return;
      if (!game.isLocalTurn) return;
      if (!golfBall.object) return;
      net.sendShotResult(game.activePlayer.id, {
        endPosition: golfBall.object.position.toArray() as [number, number, number],
        surface: details.surface,
        isHoled: details.isHoled === true,
        isInWater: details.isInWater === true,
      });
    });

    // 2. Server echoed a shot (local or remote) -> apply on every client. This
    //    both scores it and advances the turn (deterministically, same on all).
    net.on('shot', (msg) => this.applyShot(msg));

    // 3. Server echoed a hazard resolution -> apply on every client, same as a
    //    shot. Including our own: one path, and the log stays the whole truth.
    net.on('hazard', (msg) => this.applyHazard(msg));
  }

  /**
   * Score one shot from the wire. Public so shots that arrived before this
   * client had a game — while the course was still loading, or replayed by the
   * relay when resuming into a round already in progress — can be fed through
   * the same path in order. Replaying the whole log from the start rebuilds the
   * round exactly, because scoring and turn order are deterministic.
   */
  applyShot({ playerId, result }: ShotMessage) {
    const outcome = this.#game.applyShotResult(playerId, {
      endPosition: new THREE.Vector3().fromArray(result.endPosition),
      surface: result.surface as CourseColliderType | undefined,
      isHoled: result.isHoled,
      isInWater: result.isInWater,
    });
    if (outcome.awaitingHazard) {
      // Nobody's turn advanced. Whoever owns this player has to answer, and
      // announcing it here (rather than off the local ball's shotEnded) means
      // the prompt is driven by the same echo everyone else scored from — so a
      // remote player's splash never puts the dialog on our screen.
      this.emit('hazard', playerId, this.#game.localPlayerIds.has(playerId));
    }
  }

  /**
   * Play our ball out of the water. Sends only — like a shot, it takes effect
   * on the echo, so this client applies it at the same point in the log as
   * everyone else and there is no window where our game is a move ahead.
   */
  resolveHazard(action: HazardAction) {
    const playerId = this.#game.activePlayer.id;
    if (!this.#game.localPlayerIds.has(playerId)) {
      console.warn(`resolveHazard: ${playerId} is not ours to play`);
      return;
    }
    this.#net.sendHazardAction(playerId, action);
  }

  /** Apply one hazard resolution from the wire. Same replay contract as applyShot. */
  applyHazard({ playerId, action }: HazardMessage) {
    this.#game.applyHazardAction(playerId, action);
  }
}

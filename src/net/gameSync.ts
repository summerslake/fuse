import * as THREE from 'three';
import { type CourseGame } from '@/courses/game';
import { type GolfBall } from '@/objects/golfBall';
import { type NetClient } from './client';

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

export class GameSync {
  #game: CourseGame;
  #net: NetClient;

  constructor(game: CourseGame, net: NetClient, golfBall: GolfBall, opts: GameSyncOptions = {}) {
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
        surface: details.surface ? { type: details.surface.type } : undefined,
        isHoled: details.isHoled,
      });
    });

    // 2. Server echoed a shot (local or remote) -> apply on every client. This
    //    both scores it and advances the turn (deterministically, same on all).
    net.on('shot', ({ playerId, result }) => {
      this.#game.applyShotResult(playerId, {
        endPosition: new THREE.Vector3().fromArray(result.endPosition),
        surface: result.surface as { type?: any } | undefined,
        isHoled: result.isHoled,
      });
    });
  }
}

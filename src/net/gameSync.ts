import * as THREE from 'three';
import { type CourseGame } from '@/courses/game';
import { type GolfBall } from '@/objects/golfBall';
import { type NetClient } from './client';
import { type NetShotResult } from './types';

/**
 * Wires a networked CourseGame to a NetClient. This is the whole Phase 3
 * multiplayer flow in one place (so it's testable without a browser):
 *
 *   local ball stops ─▶ sendShotResult ─▶ [server] ─▶ 'shot' to everyone
 *                                                         │
 *   every client: applyShotResult(advanceTurn:false) ◀────┘
 *                                                         │
 *   owner of a finished hole ─▶ sendHoleComplete ─▶ [server] ─▶ 'turn'
 *                                                         │
 *   every client: setTurn ◀───────────────────────────────┘
 *
 * The local shot is applied via the server echo too — one code path for local
 * and remote shots (no optimistic local apply). The CourseGame must be
 * constructed with `networked: true` so its built-in shotEnded adapter is off.
 */
export class GameSync {
  #game: CourseGame;
  #net: NetClient;

  constructor(game: CourseGame, net: NetClient, golfBall: GolfBall) {
    this.#game = game;
    this.#net = net;

    // 1. Local ball came to rest -> send to the server (do NOT apply locally).
    //    Only for a player this client owns whose turn it currently is.
    golfBall.on('shotEnded', (details) => {
      if (!game.isLocalTurn) return;
      if (!golfBall.object) return;
      const payload: NetShotResult = {
        endPosition: golfBall.object.position.toArray() as [number, number, number],
        surface: details.surface ? { type: details.surface.type } : undefined,
        isHoled: details.isHoled,
        trail: downsampleTrail(golfBall.getTrailPoints?.()),
      };
      net.sendShotResult(game.activePlayer.id, payload);
    });

    // 2. Server echoed a shot (local or remote) -> apply on every client.
    net.on('shot', ({ playerId, result }) => this.#onShot(playerId, result));

    // 3. Server decided the next turn -> sync it locally.
    net.on('turn', ({ playerId, holeNumber }) => {
      if (playerId) game.setTurn(playerId, holeNumber);
    });
  }

  #onShot(playerId: string, result: NetShotResult) {
    const { holeFinished } = this.#game.applyShotResult(
      playerId,
      {
        endPosition: new THREE.Vector3().fromArray(result.endPosition),
        surface: result.surface as { type?: any } | undefined,
        isHoled: result.isHoled,
      },
      { advanceTurn: false },
    );

    // The owner of a player that just finished a hole tells the server, which
    // arbitrates the next turn. Exactly one client sends this (the owner).
    if (holeFinished && this.#game.localPlayerIds.has(playerId)) {
      const holeNumber = this.#game.activeHole.number;
      const strokes = this.#game.players.find(p => p.id === playerId)?.scorecard.get(holeNumber) ?? 0;
      this.#net.sendHoleComplete(playerId, holeNumber, strokes);
    }
  }
}

/** Max trail points to put on the wire — plenty for a smooth ghost, well under
 *  the relay's 64KB payload cap even for a long, rolling drive. */
const MAX_TRAIL_POINTS = 240;

/**
 * Even-stride downsample of a flight path for the wire. Always keeps the first
 * and last point (tee-off and rest). Returns undefined when there's nothing
 * worth replaying, so the field is simply omitted from the payload.
 */
function downsampleTrail(
  points: number[][] | undefined,
): [number, number, number][] | undefined {
  if (!points || points.length < 2) return undefined;
  const src = points as [number, number, number][];
  if (src.length <= MAX_TRAIL_POINTS) return src;

  const out: [number, number, number][] = [];
  const stride = (src.length - 1) / (MAX_TRAIL_POINTS - 1);
  for (let i = 0; i < MAX_TRAIL_POINTS; i++) {
    out.push(src[Math.round(i * stride)]);
  }
  return out;
}

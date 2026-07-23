import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { CourseGame } from '@/courses/game';
import { type Hole } from '@/courses/types';

/**
 * Phase 2 safety-gate tests for the CourseGame extraction.
 *
 * CourseGame's scoring/rotation was extracted out of the local ball's
 * `shotEnded` handler into `applyShotResult(playerId, result)`. These tests
 * drive that method directly (no GolfBall, no rapier, no GPU) and assert the
 * hot-seat behavior that must remain identical to `main`: turn rotation,
 * scorecard, auto-putt, hole advance, round end. They also cover the new
 * ownership surface (isLocalTurn, selectPlayer restriction, setTurn).
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function makeClub() {
  return { name: 'DR', id: 'DR', distance: 200 };
}

/** Two-hole course: hole 1 par 3 (pin at z=150), hole 2 par 4 (pin at z=200). */
function makeCourse() {
  const holes = new Map<number, Hole>();
  holes.set(1, {
    number: '1', par: 3,
    waypoints: new Map([
      ['tee', V(0, 0, 0)], ['aim', V(0, 0, 100)], ['pin', V(0, 0, 150)],
    ]),
  });
  holes.set(2, {
    number: '2', par: 4,
    waypoints: new Map([
      ['tee', V(0, 0, 0)], ['aim', V(0, 0, 120)], ['pin', V(0, 0, 200)],
    ]),
  });
  return { holes } as any;
}

const fakeBall = { on() {} } as any;

function makeSetup(playerIds: string[]) {
  return {
    units: 'imperial' as const,
    practiceMode: false,
    puttingEnabled: false,
    gimmeDistances: [2, 4, 80],
    players: playerIds.map((id) => ({ name: id, id, clubs: [makeClub()] })),
  };
}

function makeGame(playerIds = ['p1', 'p2'], localPlayerIds?: string[]) {
  return new CourseGame(makeCourse(), fakeBall, {
    setupData: makeSetup(playerIds) as any,
    localPlayerIds,
  });
}

const fairway = (z: number) => ({ endPosition: V(0, 0, z), surface: { type: 'fairway' } as any, isHoled: false });
const green = (z: number) => ({ endPosition: V(0, 0, z), surface: { type: 'green' } as any, isHoled: false });
const player = (g: CourseGame, id: string) => g.players.find((p) => p.id === id)!;

describe('CourseGame — turn rotation & scorecard', () => {
  let g: CourseGame;
  beforeEach(() => { g = makeGame(); });

  it('starts on player 1, hole 1', () => {
    expect(g.activePlayer.id).toBe('p1');
    expect(g.activeHole.number).toBe('1');
  });

  it('keeps the same player shooting until they finish the hole', () => {
    g.applyShotResult('p1', fairway(50));
    expect(g.activePlayer.id).toBe('p1');           // no rotation on a fairway lie
    expect(player(g, 'p1').scorecard.get('1')).toBe(1);
    expect(player(g, 'p1').strokes).toBe(1);
    expect(player(g, 'p1').start.z).toBe(50);        // start moved to landing
  });

  it('auto-putts on the green, finalizes the hole, and rotates to the next player', () => {
    g.applyShotResult('p1', fairway(50));            // stroke 1
    g.applyShotResult('p1', green(148));             // stroke 2, 2m from pin -> gimme[0], autoPutt 1

    const p1 = player(g, 'p1');
    expect(p1.scorecard.get('1')).toBe(3);           // 2 + auto-putt 1
    expect(p1.toPar).toBe(0);                        // 3 on a par 3
    expect(p1.disabled).toBe(true);
    expect(g.activePlayer.id).toBe('p2');            // rotated
  });

  it('advances to the next hole once all players finish, resetting active player and disabled flags', () => {
    // p1 finishes hole 1 in 3
    g.applyShotResult('p1', fairway(50));
    g.applyShotResult('p1', green(148));
    // p2 finishes hole 1 in 4 (3m from pin -> autoPutt 2)
    g.applyShotResult('p2', fairway(60));
    g.applyShotResult('p2', green(147));

    const p2 = player(g, 'p2');
    expect(p2.scorecard.get('1')).toBe(4);
    expect(p2.toPar).toBe(1);                        // 4 on a par 3
    expect(g.activeHole.number).toBe('2');           // advanced hole
    expect(g.activePlayer.id).toBe('p1');            // back to first player
    expect(player(g, 'p1').disabled).toBe(false);    // re-enabled for the new hole
    expect(p2.disabled).toBe(false);
  });

  it('emits roundEnded after the last hole is completed by everyone', () => {
    let ended = false;
    g.on('roundEnded', () => { ended = true; });

    for (const id of ['p1', 'p2']) {                 // hole 1
      g.applyShotResult(id, fairway(50));
      g.applyShotResult(id, green(149));
    }
    for (const id of ['p1', 'p2']) {                 // hole 2
      g.applyShotResult(id, fairway(80));
      g.applyShotResult(id, green(199));
    }
    expect(ended).toBe(true);
  });
});

describe('CourseGame — player ownership (new in Phase 2)', () => {
  it('owns every player by default, so isLocalTurn is always true', () => {
    const g = makeGame();
    expect(g.isLocalTurn).toBe(true);
    g.applyShotResult('p1', fairway(50));
    g.applyShotResult('p1', green(148));             // now p2 is active
    expect(g.activePlayer.id).toBe('p2');
    expect(g.isLocalTurn).toBe(true);                // still owned
  });

  it('isLocalTurn is false when the active player is not owned', () => {
    const g = makeGame(['p1', 'p2'], ['p1']);        // this client owns only p1
    expect(g.isLocalTurn).toBe(true);                // p1 active
    g.applyShotResult('p1', fairway(50));
    g.applyShotResult('p1', green(148));             // rotate to p2
    expect(g.activePlayer.id).toBe('p2');
    expect(g.isLocalTurn).toBe(false);               // p2 not owned
  });

  it('selectPlayer only switches to owned players', () => {
    const g = makeGame(['p1', 'p2'], ['p1']);
    g.selectPlayer({ id: 'p2' } as any);             // not owned -> ignored
    expect(g.activePlayer.id).toBe('p1');
    g.selectPlayer({ id: 'p1' } as any);             // owned -> allowed
    expect(g.activePlayer.id).toBe('p1');
  });

  it('selectPlayer is unrestricted when all players are owned (single-machine)', () => {
    const g = makeGame();
    g.selectPlayer({ id: 'p2' } as any);
    expect(g.activePlayer.id).toBe('p2');
  });
});

describe('CourseGame — setTurn (network-driven, unused until Phase 3)', () => {
  it('sets active player and hole without running scoring', () => {
    const g = makeGame();
    let emitted: string | undefined;
    g.on('nextShot', (p) => { emitted = p.id; });

    g.setTurn('p2', '2');
    expect(g.activePlayer.id).toBe('p2');
    expect(g.activeHole.number).toBe('2');
    expect(emitted).toBe('p2');
    // scoring untouched
    expect(player(g, 'p2').strokes).toBe(0);
    expect(player(g, 'p2').scorecard.size).toBe(0);
  });

  it('ignores an unknown player id', () => {
    const g = makeGame();
    g.setTurn('nobody');
    expect(g.activePlayer.id).toBe('p1');
  });
});

describe('CourseGame — documented current behavior of the hole-out branch', () => {
  // Pins the KNOWN-QUIRKY behavior preserved from main: because the hole-out
  // finalize runs after _nextPlayer(), it writes a 0 hole-score for the *next*
  // player. This test documents (not endorses) it; a deliberate fix should
  // update this expectation. See MULTIPLAYER_PLAN open items.
  it('holing out writes a spurious 0 for the next player (main behavior, preserved)', () => {
    const g = makeGame();
    g.applyShotResult('p1', { endPosition: V(0, 0, 150), surface: { type: 'green' } as any, isHoled: true });
    expect(player(g, 'p2').scorecard.get('1')).toBe(0);
  });
});

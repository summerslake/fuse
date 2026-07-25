import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { CourseGame } from '@/courses/game';
import { type Hole } from '@/courses/types';

/**
 * Tests for CourseGame's shot-by-shot "away" turn model.
 *
 * After every shot the turn passes to the player whose ball is farthest from
 * the pin among those who haven't holed out; when everyone holes out, play
 * advances to the next hole (honors == roster order off the tee). These tests
 * drive `applyShotResult(playerId, result)` directly (no GolfBall, no rapier, no
 * GPU) and follow the active player the way real play does. Turn arbitration is
 * deterministic here, which is exactly what keeps networked clients in sync.
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
/** Play a shot for whoever is currently up (mirrors real turn-gated play). */
const play = (g: CourseGame, result: any) => g.applyShotResult(g.activePlayer.id, result);

describe('CourseGame — shot-by-shot away rotation', () => {
  let g: CourseGame;
  beforeEach(() => { g = makeGame(); });

  it('starts on player 1 (roster-order honors), hole 1', () => {
    expect(g.activePlayer.id).toBe('p1');
    expect(g.activeHole.number).toBe('1');
  });

  it('passes the turn to whoever is now farthest from the pin', () => {
    // both on the tee (150 from pin) -> honors to p1
    play(g, fairway(30));                             // p1 -> 120 from pin
    expect(player(g, 'p1').scorecard.get('1')).toBe(1);
    expect(g.activePlayer.id).toBe('p2');            // p2 still on tee (150) -> away

    play(g, fairway(50));                             // p2 -> 100 from pin
    expect(g.activePlayer.id).toBe('p1');            // p1 (120) now farther than p2 (100)
    expect(player(g, 'p2').scorecard.get('1')).toBe(1);
  });

  it('lets the same player hit twice in a row while they stay farthest', () => {
    play(g, fairway(30));                             // p1 -> 120, hand to p2
    play(g, fairway(80));                             // p2 -> 70, p1 (120) still farthest
    expect(g.activePlayer.id).toBe('p1');            // p1 hits again
    expect(player(g, 'p1').strokes).toBe(1);         // p1 has only played once so far
  });

  it('holing out finalizes the shooter and hands off to the remaining player', () => {
    // p1 aces the par 3 on the tee shot
    play(g, { endPosition: V(0, 0, 150), surface: { type: 'green' } as any, isHoled: true });
    const p1 = player(g, 'p1');
    expect(p1.scorecard.get('1')).toBe(1);
    expect(p1.toPar).toBe(-2);                       // 1 on a par 3
    expect(p1.disabled).toBe(true);
    expect(g.activePlayer.id).toBe('p2');            // only p2 left on the hole
  });

  it('auto-putts on the green, finalizes the hole, and moves off that player', () => {
    play(g, fairway(30));                             // p1 -> 120, to p2
    play(g, fairway(50));                             // p2 -> 100, to p1
    play(g, green(148));                              // p1 on green 2m out -> gimme[0], autoPutt 1

    const p1 = player(g, 'p1');
    expect(p1.scorecard.get('1')).toBe(3);           // stroke 1 (tee) + 1 (green) + auto-putt 1
    expect(p1.toPar).toBe(0);
    expect(p1.disabled).toBe(true);
    expect(g.activePlayer.id).toBe('p2');            // p1 done -> p2 up
  });

  it('advances to the next hole once everyone holes out, resetting active player and flags', () => {
    // p1 finishes hole 1
    play(g, fairway(30));                             // p1 -> 120, to p2
    play(g, fairway(50));                             // p2 -> 100, to p1
    play(g, green(148));                              // p1 finishes (3), to p2
    expect(g.activePlayer.id).toBe('p2');
    play(g, green(147));                              // p2 on green 3m -> gimme[1], autoPutt 2 -> finishes

    const p2 = player(g, 'p2');
    expect(p2.scorecard.get('1')).toBe(4);           // 1 (tee) + 1 (green) + auto-putt 2
    expect(p2.toPar).toBe(1);
    expect(g.activeHole.number).toBe('2');           // advanced hole
    expect(g.activePlayer.id).toBe('p1');            // p1 scored 3 to p2's 4 -> honors
    expect(player(g, 'p1').disabled).toBe(false);
    expect(p2.disabled).toBe(false);
  });

  it('emits roundEnded after the last hole is completed by everyone', () => {
    let ended = false;
    g.on('roundEnded', () => { ended = true; });

    // hole 1: both hole out (drive onto green near pin -> auto-putt)
    play(g, green(149));                              // p1 finishes hole 1
    play(g, green(149));                              // p2 finishes hole 1 -> advance to hole 2
    expect(g.activeHole.number).toBe('2');

    // hole 2 (pin z=200): both hole out
    play(g, green(199));                              // p1 finishes hole 2
    expect(ended).toBe(false);                        // p2 still to play
    play(g, green(199));                              // p2 finishes hole 2 -> round over
    expect(ended).toBe(true);
  });
});

describe('CourseGame — honors off the tee', () => {
  const holeOut = { endPosition: V(0, 0, 150), surface: { type: 'green' } as any, isHoled: true };

  /** Walk hole 1 so p1 scores `p1Strokes` and p2 scores `p2Strokes`. */
  function playHoleOne(g: CourseGame, p1Strokes: number, p2Strokes: number) {
    // p1 has the opening tee (roster order). He keeps hitting it behind the tee
    // — 160 out to p2's 150 — so he stays away and holds the turn while we run
    // his score up, then holes out with his last stroke.
    for (let i = 0; i < p1Strokes - 1; i++) {
      expect(g.activePlayer.id).toBe('p1');
      g.applyShotResult('p1', fairway(-10));
    }
    g.applyShotResult('p1', holeOut);

    // p1 is done, so p2 is the only player left on the hole and keeps the turn
    for (let i = 0; i < p2Strokes - 1; i++) {
      expect(g.activePlayer.id).toBe('p2');
      g.applyShotResult('p2', fairway(10));
    }
    g.applyShotResult('p2', holeOut);
  }

  it('gives the next tee to the low score on the previous hole, not roster order', () => {
    const g = makeGame();
    playHoleOne(g, 8, 4);                             // p1 blows up, p2 scores 4
    expect(player(g, 'p1').scorecard.get('1')).toBe(8);
    expect(player(g, 'p2').scorecard.get('1')).toBe(4);
    expect(g.activeHole.number).toBe('2');
    expect(g.activePlayer.id).toBe('p2');            // p2 has honors
  });

  it('keeps the previous order when scores tie', () => {
    const g = makeGame();
    playHoleOne(g, 4, 4);
    expect(g.activePlayer.id).toBe('p1');            // tie -> p1 keeps the tee
  });

  it('honors only breaks ties — the away player still plays first once lies differ', () => {
    const g = makeGame();
    playHoleOne(g, 8, 4);
    expect(g.activePlayer.id).toBe('p2');            // hole 2, p2 has honors
    play(g, fairway(60));                             // p2 -> 140 from the pin (z=200)
    expect(g.activePlayer.id).toBe('p1');            // p1 still on the tee (200) -> away
  });
});

describe('CourseGame — players from a host app', () => {
  it('survives a player with no clubs (a guest added in OGS Desktop)', () => {
    const setup = makeSetup(['p1', 'p2']) as any;
    delete setup.players[1].clubs; // exactly what the host app sent

    const g = new CourseGame(makeCourse(), fakeBall, { setupData: setup });
    const guest = player(g, 'p2');
    expect(guest.clubs.length).toBeGreaterThan(0);
    expect(guest.currentClub).toBeDefined();

    // and the round still plays — autoSelectClub reads clubs[] too
    play(g, fairway(30));
    expect(g.activePlayer.id).toBe('p2');
  });
});

describe('CourseGame — player ownership', () => {
  it('owns every player by default, so isLocalTurn is always true', () => {
    const g = makeGame();
    expect(g.isLocalTurn).toBe(true);
    play(g, fairway(30));                             // now p2 is up
    expect(g.activePlayer.id).toBe('p2');
    expect(g.isLocalTurn).toBe(true);                // still owned
  });

  it('isLocalTurn is false when the active player is not owned', () => {
    const g = makeGame(['p1', 'p2'], ['p1']);        // this client owns only p1
    expect(g.isLocalTurn).toBe(true);                // p1 active on the tee
    play(g, fairway(30));                             // rotate to p2 (away)
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

describe('CourseGame — networked mode', () => {
  it('does not wire the ball adapter when networked (GameSync drives applyShotResult)', () => {
    const g = new CourseGame(makeCourse(), fakeBall, {
      setupData: makeSetup(['p1', 'p2']) as any,
      networked: true,
    });
    expect(g.networked).toBe(true);
    expect(player(g, 'p1').scorecard.size).toBe(0);   // nothing applied yet
  });

  it('applyShotResult scores and advances the away turn identically to single-machine', () => {
    const g = new CourseGame(makeCourse(), fakeBall, {
      setupData: makeSetup(['p1', 'p2']) as any,
      networked: true,
    });
    const out = g.applyShotResult('p1', fairway(30));
    expect(out.holeFinished).toBe(false);
    expect(g.activePlayer.id).toBe('p2');             // away rotation runs in networked mode too
    expect(player(g, 'p1').scorecard.get('1')).toBe(1);
  });
});

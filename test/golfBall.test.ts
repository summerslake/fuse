import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { GolfBall } from '@/objects/golfBall';

/**
 * The ball holds `isShotActive` after a splash until the hazard is resolved —
 * that flag is what blocks the next swing. In multiplayer every client replays
 * a remote player's shot on its own ball, so every client's ball ends up
 * holding it, and only a reset releases the ones that don't own the shooter.
 */
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function makeBall() {
  return new GolfBall(new THREE.Scene(), {
    groundMeshes: [],
    setupData: { practiceMode: false } as any,
    clearTrail: 'never' as any, // no trail: it needs a GPU material
    waitTime: 3000,
  } as any);
}

describe('GolfBall — reset releases a ball left in the water', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('holds the shot lock after a splash, and reset clears it', () => {
    vi.useFakeTimers();
    const ball = makeBall();
    ball.isShotActive = true;                     // a shot is in the air
    ball._onShotEnded({ isInWater: true });       // ...and comes down in the lake
    vi.advanceTimersByTime(3000);
    expect(ball.isShotActive).toBe(true);         // locked until the hazard is resolved

    ball.reset(V(0, 0, 100), V(0, 0, 0));         // next shot is set up (any client)
    expect(ball.isShotActive).toBe(false);
  });

  it('a reset cancels the previous shot\'s pending end-of-shot timer', () => {
    vi.useFakeTimers();
    const ball = makeBall();
    const ended = vi.fn();
    ball.on('shotEnded', ended);

    ball.isShotActive = true;
    ball._onShotEnded({ isInWater: true });       // at rest, 3s settle timer running
    ball.reset(V(0, 0, 100), V(0, 0, 0));         // turn moved on before it fired
    vi.advanceTimersByTime(5000);

    expect(ended).not.toHaveBeenCalled();         // no stale landing reported
    expect(ball.isShotActive).toBe(false);        // and the fresh ball isn't re-locked
  });
});

import * as THREE from 'three';
import { BallTrail } from '@/objects/ballTrail';

type GhostBallOptions = {
  /** trail + ball tint; defaults to a cool blue to read as "not you". */
  color?: THREE.Color | number;
  /** ball radius in metres (matches GolfBall by default). */
  radius?: number;
  /** metres of flight path replayed per second (constant-velocity). */
  speed?: number;
  /** shortest / longest replay duration in seconds, regardless of speed. */
  minDuration?: number;
  maxDuration?: number;
  /** how long the ball + trail linger at rest before hiding, in ms. */
  lingerMs?: number;
};

/**
 * A lightweight "ghost" of a remote player's shot: a sphere that flies along a
 * received world-space path while a {@link BallTrail} draws behind it, exactly
 * mirroring how the real GolfBall renders — but with no physics. Scoring is
 * handled elsewhere (GameSync); this is pure visualization so you can watch
 * Brett's ball fly instead of just seeing his scorecard tick.
 *
 * Drive it from the render loop: call {@link play} when a remote 'shot' arrives
 * and {@link update} every frame.
 */
export class GhostBall {
  object: THREE.Mesh;
  trail: BallTrail;

  #scene: THREE.Scene;
  #speed: number;
  #minDuration: number;
  #maxDuration: number;
  #lingerMs: number;

  /** arc-length parametrized path: cumulative[i] is distance to point[i]. */
  #path: THREE.Vector3[] = [];
  #cumulative: number[] = [];
  #total = 0;

  #state: 'idle' | 'flying' | 'lingering' = 'idle';
  #elapsed = 0;
  #duration = 0;
  #lingerLeft = 0;

  constructor(scene: THREE.Scene, options: GhostBallOptions = {}) {
    this.#scene = scene;
    this.#speed = options.speed ?? 55;
    this.#minDuration = options.minDuration ?? 0.6;
    this.#maxDuration = options.maxDuration ?? 4.0;
    this.#lingerMs = options.lingerMs ?? 2500;

    const color = options.color instanceof THREE.Color
      ? options.color
      : new THREE.Color(options.color ?? '#4ea1ff');
    const radius = options.radius ?? 0.0213;

    const geometry = new THREE.IcosahedronGeometry(radius, 4);
    this.object = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
    this.object.castShadow = false;
    this.object.frustumCulled = false;
    this.object.visible = false;
    scene.add(this.object);

    // Trail follows the ghost's position, same as the real ball's trail does.
    this.trail = new BallTrail(scene, this.object, { color });
  }

  /** True while a replay (flight or its linger tail) is on screen. */
  get isPlaying() {
    return this.#state !== 'idle';
  }

  /**
   * Replay a flight path. `points` is the world-space trail from the shooter
   * (NetShotResult.trail). Anything shorter than 2 points is ignored.
   */
  play(points: ReadonlyArray<readonly [number, number, number]>) {
    if (!points || points.length < 2) return;

    this.#path = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.#cumulative = [0];
    this.#total = 0;
    for (let i = 1; i < this.#path.length; i++) {
      this.#total += this.#path[i].distanceTo(this.#path[i - 1]);
      this.#cumulative.push(this.#total);
    }

    this.#duration = Math.min(
      this.#maxDuration,
      Math.max(this.#minDuration, this.#total / this.#speed),
    );
    this.#elapsed = 0;
    this.#state = 'flying';

    this.object.position.copy(this.#path[0]);
    this.object.visible = true;
    this.trail.reset(this.object);
  }

  update(delta: number) {
    if (this.#state === 'idle') return;

    if (this.#state === 'flying') {
      this.#elapsed += delta;
      const t = this.#duration > 0 ? Math.min(this.#elapsed / this.#duration, 1) : 1;
      this.#sampleTo(t * this.#total);
      this.trail.update(true); // collect + draw, mirroring the live ball

      if (t >= 1) {
        this.#state = 'lingering';
        this.#lingerLeft = this.#lingerMs;
      }
      return;
    }

    // lingering: hold the ball + full trail at rest, then clear.
    this.#lingerLeft -= delta * 1000;
    if (this.#lingerLeft <= 0) {
      this.object.visible = false;
      this.trail.clear();
      this.#state = 'idle';
    }
  }

  /** Position the ghost `dist` metres along the arc-length path. */
  #sampleTo(dist: number) {
    const cum = this.#cumulative;
    const path = this.#path;
    if (dist <= 0) { this.object.position.copy(path[0]); return; }
    if (dist >= this.#total) { this.object.position.copy(path[path.length - 1]); return; }

    // find the segment [i-1, i] containing `dist`
    let i = 1;
    while (i < cum.length && cum[i] < dist) i++;
    const segLen = cum[i] - cum[i - 1];
    const f = segLen > 0 ? (dist - cum[i - 1]) / segLen : 0;
    this.object.position.copy(path[i - 1]).lerp(path[i], f);
  }

  dispose() {
    this.trail.dispose();
    this.#scene.remove(this.object);
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

import * as THREE from 'three';
import { type CourseLoader } from './loader';
import { Hole, PlayerState } from './types';
import { type GolfBall } from '@/objects/golfBall';
import { type CourseColliderType } from '@/courses/surfaces';
import EventEmitter from 'eventemitter3';
import { CoursePlayer } from './player';
import { DefaultGimmeDistances } from '@/utils/data';
import { ShotEndEvent } from '@/physics/ballPhysics';

// how far away from the tee box position to auto-aim at the pin instead of aim point
const AIMPOINT_THRESHOLD = 25;
// drop search tuning
const DROP_RING_STEP = 1;        // meters between sampling rings
const DROP_RING_SAMPLES = 12;    // angular samples per ring
const DROP_RAY_HEIGHT = 10;      // cast downward from this height above candidate
const INVALID_DROP_SURFACES = ['plane_river', 'plane_lake', 'water', 'bunker', 'green'];

interface CourseGameEvents {
  nextShot: (player: CoursePlayer) => void;
  roundEnded: () => void;
}
// export type PlayerStatus = {
//   player: CoursePlayer;
//   state: Partial<PlayerState>;
// }
type CourseGameOptions = {
  setupData: OpenGolfSim.SetupData,
  /**
   * IDs of the players this client simulates locally. Defaults to ALL players,
   * which is exactly single-machine behavior (this client owns everyone, so
   * `isLocalTurn` is always true). In multiplayer each client passes only the
   * players it owns.
   */
  localPlayerIds?: string[],
  /**
   * Multiplayer mode. When true, the local ball's shotEnded does NOT auto-apply
   * scoring — the network layer (GameSync) routes every shot through the server
   * and calls applyShotResult on the echo, so local and remote shots share one
   * path. Turn order is still derived locally (identically on every client).
   */
  networked?: boolean,
}

/** How a player resolves a ball that finished in a water hazard. */
export type HazardAction = 'drop' | 'rehit' | 'mulligan';

/**
 * The outcome of a completed shot expressed as plain data — no reference to the
 * local `GolfBall`. This is what `applyShotResult` consumes, so the same scoring
 * path serves both a locally simulated shot and one replayed from the network.
 * Mirrors the scoring-relevant fields of `ShotEndEvent`, minus the ball.
 */
export type ShotResultInput = {
  endPosition: THREE.Vector3,
  surface?: CourseColliderType,
  isHoled: boolean,
  /** ball finished in a lake/river — unplayable, resolved via drop/rehit/mulligan */
  isInWater?: boolean,
}

/** What applyShotResult reports back to the caller. */
export type ShotResultOutcome = {
  /** true if this shot completed the player's hole (holed out or green auto-putt) */
  holeFinished: boolean,
  /** true if the ball is in a hazard: the turn has NOT moved, a HazardAction is owed */
  awaitingHazard: boolean,
}

export class CourseGame extends EventEmitter<CourseGameEvents> {
  course: CourseLoader;
  golfBall: GolfBall;
  players: CoursePlayer[];
  practiceMode: boolean;
  currentPlayerIndex: number;
  currentHoleIndex: number;
  activePlayer: CoursePlayer;
  activeHole: Hole;
  puttingEnabled: boolean;
  gimmeDistances: number[];
  /** Players this client owns. See CourseGameOptions.localPlayerIds. */
  localPlayerIds: Set<string>;
  /** Multiplayer mode. See CourseGameOptions.networked. */
  networked: boolean;
  #orderedHoles: Hole[];
  /**
   * Honors: player ids in the order they earned the tee, best score on the last
   * hole first. Used to break "away" ties — chiefly on the tee, where every lie
   * is the same point. Starts as roster order.
   */
  #honors: string[];
  /**
   * Who owes a hazard resolution, if anyone. Also the guard that makes applying
   * one exactly-once: a duplicate `hazard` message (a double-tapped button, a
   * reconnect replaying an event we already had) would otherwise stack a second
   * penalty stroke on one client and desync the round.
   */
  #awaitingHazardFor: string | null = null;
  // #playerData: Map<string, PlayerState>;

  constructor(course: CourseLoader, golfBall: GolfBall, options: CourseGameOptions) {
    super();
    this.course = course;
    this.players = options?.setupData.players.map(player => new CoursePlayer(player));
    this.practiceMode = !!options?.setupData.practiceMode;
    this.golfBall = golfBall;
    this.gimmeDistances = options?.setupData.gimmeDistances || DefaultGimmeDistances;
    this.puttingEnabled = !!options?.setupData.puttingEnabled;

    // default: own every player (single-machine play), so isLocalTurn is always true
    this.localPlayerIds = new Set(options?.localPlayerIds ?? this.players.map(p => p.id));
    this.networked = !!options?.networked;

    this.currentPlayerIndex = 0;
    this.currentHoleIndex = 0;
    this.#honors = this.players.map(p => p.id);
    this.#orderedHoles = Array.from(this.course.holes.values()).map(h => ({ ...h, _num: parseInt(h.number) })).sort((a, b) => (a._num < b._num ? -1 : 1));
    if (!this.#orderedHoles.length) {
      throw new Error('Course has no holes!');
    }

    this.activePlayer = this.players[this.currentPlayerIndex];
    this.activeHole = this.#orderedHoles[this.currentHoleIndex];
    // this.#playerData = new Map();

    // Single-machine: the local ball's final state feeds the shared scoring path
    // directly. In networked mode this adapter is OFF — GameSync routes every
    // shot through the server and calls applyShotResult on the echo, so local
    // and remote shots share one path.
    if (!this.networked) {
      this.golfBall.on('shotEnded', (details) => {
        if (!this.golfBall.object) {
          throw new Error('GolfBall object not found');
        }
        this.applyShotResult(this.activePlayer.id, {
          endPosition: this.golfBall.object.position.clone(),
          surface: details.surface,
          isHoled: details.isHoled === true,
          isInWater: details.isInWater === true,
        });
      });
    }

    // setup first hole
    this._setupHole();
  }

  /** True when the player whose turn it is belongs to this client. */
  get isLocalTurn(): boolean {
    return this.localPlayerIds.has(this.activePlayer.id);
  }
  
  _setupHole() {
    const hole = this.activeHole;
    const holeStart = hole.waypoints.get('tee');
    const holeAim = hole.waypoints.get('aim');
    const holePin = hole.waypoints.get('pin');
    if (!holeStart) {
      throw new Error('Missing hole start position!');
    }
    if (!holePin) {
      throw new Error('Missing hole pin position!');
    }
    // set initial player positions
    this.players.forEach((player, index) => {
      player.disabled = false;
      player.resetPositions(holeStart, holePin, holeAim);
    });
  }
  
  pinPoint(): THREE.Vector3 {
    const pos = this.activePlayer.pin;
    if (!pos) throw new Error('Unable to find PIN position');
    return pos;
  }
  
  startPoint(): THREE.Vector3 {
    const pos = this.activePlayer.start;
    if (!pos) throw new Error('Unable to find START position');
    return pos;
  }

  updateStartPoint(point: THREE.Vector3) {
    this.activePlayer.start.copy(point);
    this.updateAimPoint(point);
  }
  
  aimPoint(): THREE.Vector3 {
    // const pos = this.#playerData.get(this.activePlayer.id)?.aim || this.#playerData.get(this.activePlayer.id)?.pin;
    const pos = this.activePlayer.aim || this.activePlayer.pin;
    if (!pos) throw new Error('Unable to find AIM position');
    return pos;
  }

  updateAimPoint(position: THREE.Vector3) {
    // const playerState = this.#playerData.get(this.activePlayer.id);
    // if (!playerState) {
    //   throw new Error('No player found!');
    // }
    const distFromStart = this.activePlayer.originalStart?.distanceTo(position) || 0;
    if (this.activePlayer.pin && distFromStart > AIMPOINT_THRESHOLD) {
      // playerState.aim ? playerState.aim.copy(playerState.pin) : playerState.aim = playerState.pin.clone();
      this.activePlayer.aim = this.activePlayer.pin.clone();
    }
  }

  _onHoleEnded() {
    console.log('_onHoleEnded');
  }

  _addStrokes(player: CoursePlayer, strokes = 1, endOfHole = false) {
    player.strokes += strokes;
    const holeKey = `${this.activeHole.number}`;
    const existingHoleScore = player.scorecard.get(holeKey);
    // finalize player hole score
    const newHoleScore = existingHoleScore ? existingHoleScore + strokes : strokes;
    player.scorecard.set(holeKey, newHoleScore);

    if (endOfHole) {
      // Sum only the holes this player has actually finished. (Indexing by
      // currentHoleIndex would charge them par for holes still in progress —
      // and under shot-by-shot play a player can hole out while others are
      // still on the hole.)
      player.toPar = this.#orderedHoles.reduce((prev, hole) => {
        if (!player.hasFinishedHole(hole.number)) { return prev; }
        const s = player.scorecard.get(`${hole.number}`);
        const diff = (s || 0) - hole.par;
        return prev + diff;
      }, 0);
    }
  }

  /**
   * Apply a completed shot to game state from plain data. Called by the local
   * ball's shotEnded adapter (single-machine) or by GameSync on a network echo
   * (multiplayer) — same shape either way. No reference to the local GolfBall.
   *
   * Turn model: **shot-by-shot, "away" plays next.** After every shot the turn
   * passes to the player whose ball lies farthest from the pin among those who
   * haven't holed out. When everyone has holed out, advance to the next hole,
   * where all lies are equal and the tie goes to honors — the low score on the
   * hole just played (roster order on the first tee). This is fully
   * deterministic from the shot data + course, so every networked client
   * computes the identical turn without any server arbitration.
   *
   * A shot into water is the one case that does NOT hand off the turn: the ball
   * is unplayable, so the shot isn't finished until the shooter picks drop /
   * rehit / mulligan, and each of those runs the turn rules itself.
   *
   * The shooter is resolved from `playerId` (not assumed to be activePlayer) so
   * a late/echoed network result still scores the right player.
   */
  applyShotResult(
    playerId: string,
    result: ShotResultInput,
  ): ShotResultOutcome {
    const player = this.players.find(p => p.id === playerId);
    if (!player) {
      throw new Error(`applyShotResult: no player with id ${playerId}`);
    }
    if (player !== this.activePlayer) {
      // Should not happen in turn-based play; guard for network edge cases.
      console.warn(`applyShotResult: result for ${playerId} but active player is ${this.activePlayer.id}`);
    }

    this._addStrokes(player);

    // store for mulligans
    if (!player.previousStart) {
      player.previousStart = new THREE.Vector3();
    }
    player.previousStart.copy(player.start);

    let holeFinished = false;
    let awaitingHazard = false;
    if (!this.practiceMode) {
      player.start.copy(result.endPosition);
      // hack greens as done
      if (result.isInWater) {
        // Unplayable lie: the stroke counts, but the shot isn't resolved and
        // the turn does not move. The hazard dialog is up for the shooter, and
        // drop/rehit/mulligan finishes the shot.
        awaitingHazard = true;
      } else if (result.isHoled) {
        holeFinished = true;
        console.log(`Ball in hole! End hole`);
        this._addStrokes(player, 0, true);
        player.disabled = true;
      } else if (result.surface === 'green' && !this.puttingEnabled) {
        holeFinished = true;
        // total score
        // TODO: change to add auto-putt number
        const holePos = this.activeHole.waypoints.get('pin');
        const distanceToHole = holePos?.distanceTo(result.endPosition) || Infinity;
        let autoPutt = 3;
        if (distanceToHole <= this.gimmeDistances[0]) {
          autoPutt = 1;
        } else if (distanceToHole <= this.gimmeDistances[1]) {
          autoPutt = 2;
        }
        console.log(`Distance to hole: ${distanceToHole}m, auto-putt score: ${autoPutt}`);
        this._addStrokes(player, autoPutt, true);

        // disable player when they finish a hole (so they are not selectable in UI)
        player.disabled = true;
      }
    }

    if (awaitingHazard) {
      this.#awaitingHazardFor = player.id;
      return { holeFinished: false, awaitingHazard: true };
    }
    return this.#advanceTurn(holeFinished);
  }

  /**
   * Hand the turn to whoever is up now and announce it. Every path that
   * completes a shot ends here — a normal shot, and each hazard resolution —
   * so the away rule is applied in exactly one place and every client derives
   * the same next player from the same state.
   */
  #advanceTurn(holeFinished: boolean): ShotResultOutcome {
    if (this.players.every(p => p.disabled)) {
      // everyone holed out this hole -> next hole (or the round is over)
      if (!this._advanceHole()) {
        this.emit('roundEnded');
        return { holeFinished, awaitingHazard: false };
      }
    }
    this.currentPlayerIndex = this.#findAwayPlayer();
    this.activePlayer = this.players[this.currentPlayerIndex];

    this.updateAimPoint(this.activePlayer.start);
    this.emit('nextShot', this.activePlayer);

    return { holeFinished, awaitingHazard: false };
  }

  switchHole(hole: Hole) {
    this.currentHoleIndex = this.#orderedHoles.findIndex(h => h.number === hole.number);
    this.activeHole = this.#orderedHoles[this.currentHoleIndex]
    this._setupHole();
  }

  /**
   * Advance to the next hole in order. Resets positions/disabled via _setupHole.
   * @returns false when there is no next hole (the round is over).
   */
  _advanceHole(): boolean {
    const next = this.currentHoleIndex + 1;
    if (next >= this.#orderedHoles.length) {
      console.log('Course finished!');
      return false;
    }
    this.#updateHonors(this.activeHole.number);
    this.currentHoleIndex = next;
    this.activeHole = this.#orderedHoles[this.currentHoleIndex];
    this._setupHole();
    return true;
  }

  /**
   * Recompute honors from the hole just played: lowest score tees off first.
   * Players who tie keep the order they already had (a stable sort), which is
   * how honors actually carry over. Anyone without a score for that hole goes
   * last. Deterministic from the scorecards, so every client agrees.
   */
  #updateHonors(holeNumber: string) {
    const scoreOf = (id: string) =>
      this.players.find(p => p.id === id)?.scorecard.get(holeNumber) ?? Infinity;
    this.#honors = [...this.#honors].sort((a, b) => scoreOf(a) - scoreOf(b));
  }

  /**
   * Index of the player who is "away" — farthest from the pin among those who
   * haven't holed out. Ties (e.g. everyone on the tee, where all lies are the
   * same point) go to whoever has honors — the low score on the previous hole.
   * Deterministic across clients: identical lies + pin + scorecards -> identical
   * result, which is what keeps networked turn order in sync without a server.
   */
  #findAwayPlayer(): number {
    let bestIndex = 0;
    let bestDist = -Infinity;
    let bestHonors = Infinity;
    this.players.forEach((player, index) => {
      if (player.disabled) return; // holed out this hole
      const pin = player.pin;
      const dist = pin ? player.start.distanceTo(pin) : 0;
      const honorsIndex = this.#honors.indexOf(player.id);
      const honors = honorsIndex === -1 ? Number.MAX_SAFE_INTEGER : honorsIndex;
      if (dist > bestDist || (dist === bestDist && honors < bestHonors)) {
        bestDist = dist;
        bestHonors = honors;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  currentHole() {
    const hole = this.course.holes.get(parseInt(this.activeHole.number));
    if (!hole) {
      throw new Error(`Missing hole ${this.activeHole.number}!`);
    }
    return hole;
  }

  selectPlayer(player: OpenGolfSim.Player) {
    // Only players this client owns can be manually selected. In single-machine
    // play localPlayerIds contains everyone, so this is unrestricted as before.
    if (!this.localPlayerIds.has(player.id)) {
      console.warn(`selectPlayer: ${player.id} is not owned by this client`);
      return;
    }
    const newIndex = this.players.findIndex(p => p.id === player.id);
    if (newIndex > -1) {
      this.currentPlayerIndex = newIndex;
      this.activePlayer = this.players[this.currentPlayerIndex];
      // let playerState = this.#playerData.get(this.activePlayer.id);
      // if (!playerState) throw new Error('Missing player state data');
      this.emit('nextShot', this.activePlayer);
    }
  }

  autoSelectClub() {
    if (!this.golfBall.object) {
      console.error('No golf ball object!');
      return;
    }
    // console.error('Current surface', this.golfBall);

    if (this.golfBall.isOnGreen(true)) {
      this.activePlayer.currentClub = this.activePlayer.clubs[this.activePlayer.clubs.length - 1];
      return;
    }
    const holePos = this.activeHole.waypoints.get('pin');
    const distanceToHole = holePos?.distanceTo(this.golfBall.object.position) || Infinity;    

    // sort by shortest distance (minus putter)...
    const sortedClubs = [...this.activePlayer.clubs.slice(0, -1)].sort((a, b) => a.distance > b.distance ? -1 : 1);
    for (const club of sortedClubs) {
      if (club.distance <= distanceToHole) {
        console.log(`Auto-selecting club: ${club.id}, distanceToHole: ${distanceToHole}`);
        this.activePlayer.currentClub = club;
        return;
      }
    }
    this.activePlayer.currentClub = sortedClubs[sortedClubs.length - 1];
  }
  
  selectClub(club: OpenGolfSim.Club) {
    this.activePlayer.currentClub = club;
  }

  getActiveHoleNumber() {
    return parseInt(this.activeHole.number) || 0;
  }
  
  update(dt: number) {
    // const hole = this.course.holes.get(parseInt(this.activeHole.number));
    // if (hole?.green?.target) {
    //   hole.green.target.update(this.golfBall, dt);
    //   hole.green.flag.update(dt);
    // }
  }

  /**
   * Resolve a shot that finished in a hazard, and hand the turn on.
   *
   * Every one of these mutates the scorecard and a player's lie, so in
   * multiplayer they must run on every client, not just the shooter's — hence
   * the explicit `playerId` and the total absence of `golfBall` reads. The
   * ball's resting place is already in `player.start` (applyShotResult put it
   * there before returning `awaitingHazard`), and the drop search raycasts the
   * course, which every client has loaded identically. So the outcome is
   * derived, not transmitted: the wire only carries which button was pressed.
   */
  applyHazardAction(playerId: string, action: HazardAction): ShotResultOutcome {
    const player = this.players.find(p => p.id === playerId);
    if (!player) {
      throw new Error(`applyHazardAction: no player with id ${playerId}`);
    }
    if (this.#awaitingHazardFor !== playerId) {
      // Nothing is owed (or it's owed by someone else) — this is a duplicate or
      // a stale replay. Applying it would add a phantom penalty stroke.
      console.warn(`applyHazardAction: ${playerId} does not owe a hazard resolution`);
      return { holeFinished: false, awaitingHazard: this.#awaitingHazardFor !== null };
    }
    if (!player.previousStart) {
      console.warn(`applyHazardAction: ${playerId} has no previous position`);
      return { holeFinished: false, awaitingHazard: true };
    }
    this.#awaitingHazardFor = null;

    if (action === 'drop') {
      const dropPoint = player.pin
        ? this._findDropPoint(player.start.clone(), player.pin, player.previousStart)
        : null;
      if (dropPoint) {
        player.start.copy(dropPoint);
      } else {
        // no valid surface found: stroke and distance
        console.warn('No valid drop point found, returning to previous position');
        player.start.copy(player.previousStart);
      }
      this._addStrokes(player, 1); // penalty stroke
    } else {
      // rehit and mulligan both play again from the previous spot; a mulligan
      // additionally erases the stroke that put the ball in the water.
      player.start.copy(player.previousStart);
      if (action === 'mulligan') {
        this._addStrokes(player, -1);
      }
    }

    if (this.localPlayerIds.has(playerId)) {
      this.golfBall.isShotActive = false;
    }
    return this.#advanceTurn(false);
  }

  rehit() {
    return this.applyHazardAction(this.activePlayer.id, 'rehit');
  }

  mulligan() {
    return this.applyHazardAction(this.activePlayer.id, 'mulligan');
  }

  drop() {
    return this.applyHazardAction(this.activePlayer.id, 'drop');
  }

  _findDropPoint(ballPos: THREE.Vector3, pin: THREE.Vector3, prev: THREE.Vector3): THREE.Vector3 | null {
    const meshes = this.course.getGroundMeshes();
    const raycaster = new THREE.Raycaster();
    raycaster.firstHitOnly = true; // requires three-mesh-bvh acceleration (already in use)

    const ballToPin = ballPos.distanceTo(pin);
    const ballToPrev = ballPos.distanceTo(prev);
    const maxRadius = ballToPrev; // beyond this, previousStart is strictly better

    const origin = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);

    for (let radius = DROP_RING_STEP; radius <= maxRadius; radius += DROP_RING_STEP) {
      let best: THREE.Vector3 | null = null;
      let bestPinDist = Infinity;

      for (let i = 0; i < DROP_RING_SAMPLES; i++) {
        const angle = (i / DROP_RING_SAMPLES) * Math.PI * 2;
        origin.set(
          ballPos.x + Math.cos(angle) * radius,
          ballPos.y + DROP_RAY_HEIGHT,
          ballPos.z + Math.sin(angle) * radius
        );

        raycaster.set(origin, down);
        const hit = raycaster.intersectObjects(meshes, false)[0];
        if (!hit) continue;

        const surface = hit.object.userData?.surface;
        if (!surface || INVALID_DROP_SURFACES.includes(surface)) continue;

        const pinDist = hit.point.distanceTo(pin);
        if (pinDist < ballToPin) continue;              // never closer to the hole
        if (hit.point.distanceTo(prev) > ballToPrev) continue; // stay on the near side

        if (pinDist < bestPinDist) {
          bestPinDist = pinDist;
          best = hit.point.clone();
        }
      }

      // first ring with any valid hit wins (nearest to ball), tie-broken toward pin
      if (best) return best;
    }
    return null;
  }  
}

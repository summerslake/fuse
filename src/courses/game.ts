import * as THREE from 'three';
import { type CourseLoader } from './loader';
import { Hole, PlayerState } from './types';
import { type GolfBall } from '@/objects/golfBall';
import { type CourseSurfaceProperties } from '@/courses/surfaces';
import EventEmitter from 'eventemitter3';
import { CoursePlayer } from './player';
import { DefaultGimmeDistances } from '@/utils/data';

// how far away from the tee box position to auto-aim at the pin instead of aim point
const AIMPOINT_THRESHOLD = 25;

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
   * path. Turn advance comes from the server (setTurn), not from applyShotResult.
   */
  networked?: boolean,
}

/**
 * The outcome of a completed shot expressed as plain data — no reference to the
 * local `GolfBall`. This is what `applyShotResult` consumes, so the same scoring
 * path serves both a locally simulated shot and one replayed from the network.
 * `surface` is intentionally only `{ type }` — that's all scoring reads, and it
 * keeps the network payload small (a full CourseSurfaceProperties also satisfies
 * this).
 */
export type ShotResultInput = {
  endPosition: THREE.Vector3,
  surface?: Pick<CourseSurfaceProperties, 'type'>,
  isHoled: boolean,
}

/** What applyShotResult reports back to the caller. */
export type ShotResultOutcome = {
  /** true if this shot completed the player's hole (holed out or green auto-putt) */
  holeFinished: boolean,
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
          isHoled: details.isHoled,
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
      player.toPar = this.#orderedHoles.slice(0, this.currentHoleIndex + 1).reduce((prev, hole) => {
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
   * Turn-based invariant: the shot belongs to the player whose turn it is, so
   * `playerId` is expected to be the active player. We resolve the shooter from
   * `playerId` (rather than assuming activePlayer) so out-of-order network
   * results score the right player.
   *
   * @param opts.advanceTurn  When true (default, single-machine), a finished
   *   hole rotates to the next player locally. When false (multiplayer), scoring
   *   happens but the turn does NOT advance here — the server decides the next
   *   turn and GameSync calls setTurn. In that mode nextShot is emitted only when
   *   the same player keeps shooting (hole not finished).
   * @returns whether this shot finished the player's hole.
   */
  applyShotResult(
    playerId: string,
    result: ShotResultInput,
    opts: { advanceTurn?: boolean } = {},
  ): ShotResultOutcome {
    const advanceTurn = opts.advanceTurn ?? true;
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
    if (!this.practiceMode) {
      player.start.copy(result.endPosition);
      // hack greens as done
      if (result.isHoled) {
        holeFinished = true;
        console.log(`Ball in hole! End hole`);
        // Finalize the shooter's hole score, then (single-machine) rotate.
        this._addStrokes(player, 0, true);
        player.disabled = true;
        if (advanceTurn) this._nextPlayer();
      } else if (result.surface?.type === 'green' && !this.puttingEnabled) {
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
        if (advanceTurn) this._nextPlayer();
      }
    }

    // Emit nextShot to reconfigure the scene for whoever is now active. In
    // networked mode, a FINISHED hole waits for the server's turn -> setTurn
    // instead (so we don't set up the finished player to shoot again).
    if (advanceTurn || !holeFinished) {
      this.updateAimPoint(this.activePlayer.start);
      this.emit('nextShot', this.activePlayer);
    }

    return { holeFinished };
  }

  switchHole(hole: Hole) {
    this.currentHoleIndex = this.#orderedHoles.findIndex(h => h.number === hole.number);
    this.activeHole = this.#orderedHoles[this.currentHoleIndex]
    this._setupHole();
  }

  _nextHole() {
    const nextUnfinishedHole = this.#orderedHoles.findIndex(hole => !this.#allPlayersFinishedHole(hole.number));
    if (nextUnfinishedHole === -1) {
      console.log('Course finished!');
      this.emit('roundEnded');
      return;
    }
    this.currentHoleIndex = nextUnfinishedHole;
    this.activeHole = this.#orderedHoles[this.currentHoleIndex]
    this._setupHole();
  }

  #findNextPlayerUp() {
    // default rotation type
    // loop through until we find the next player that hasn't finished the hole
    for (let i = 1; i <= this.players.length; i++) {
      const index = (this.currentPlayerIndex + i) % this.players.length;
      const finished = this.players[index].hasFinishedHole(this.activeHole.number);
      if (!finished) {
        return index;
      }
    }
    return -1;
  }

  #allPlayersFinishedHole(holeNumber?: string) {
    return this.players.every(player => player.hasFinishedHole(holeNumber ? holeNumber : this.activeHole.number))
  }

  _nextPlayer() {
    if (this.#allPlayersFinishedHole()) {
      console.log('All players have finished hole');
      // TODO: respect honors of last hole?
      this.currentPlayerIndex = 0;
      this._nextHole();
    } else {
      const nextUp = this.#findNextPlayerUp();
      if (nextUp === -1) {
        throw new Error('Could not determine next player!');
      }
      this.currentPlayerIndex = nextUp;
    }
    this.activePlayer = this.players[this.currentPlayerIndex];
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

  /**
   * Set the active player/hole from an external source (the server's turn
   * broadcast in multiplayer) WITHOUT running local scoring. Local play uses
   * _nextPlayer instead; this is unused until Phase 3.
   */
  setTurn(playerId: string, holeNumber?: string) {
    const playerIndex = this.players.findIndex(p => p.id === playerId);
    if (playerIndex === -1) {
      console.warn(`setTurn: unknown player ${playerId}`);
      return;
    }
    // A hole change means every player moves to the new tee — reset positions
    // and re-enable them, same as _nextHole does in single-machine play.
    if (holeNumber !== undefined && holeNumber !== this.activeHole.number) {
      const holeIndex = this.#orderedHoles.findIndex(h => h.number === holeNumber);
      if (holeIndex > -1) {
        this.currentHoleIndex = holeIndex;
        this.activeHole = this.#orderedHoles[this.currentHoleIndex];
        this._setupHole();
      }
    }
    this.currentPlayerIndex = playerIndex;
    this.activePlayer = this.players[this.currentPlayerIndex];
    this.emit('nextShot', this.activePlayer);
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

}

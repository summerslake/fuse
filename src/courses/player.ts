import * as THREE from 'three';
import { DefaultClubs } from '@/utils/data';

export interface CoursePlayer extends OpenGolfSim.Player {}

export class CoursePlayer {
  strokes = 0;
  toPar = 0;
  disabled: boolean;
  player: OpenGolfSim.Player;
  currentClub: OpenGolfSim.Club;
  previousStart?: THREE.Vector3;
  originalStart?: THREE.Vector3;
  originalAim?: THREE.Vector3;
  start: THREE.Vector3;
  aim?: THREE.Vector3;
  pin?: THREE.Vector3;
  scorecard: Map<string, number>;

  constructor(player: OpenGolfSim.Player) {
    this.player = player;
    this.name = player.name;
    this.id = player.id;
    // A host app can hand us a player with no bag — a guest added in OGS
    // Desktop's player manager arrives with `clubs` undefined, and reading
    // clubs[0] off that took the whole round down before it loaded.
    this.clubs = player.clubs?.length ? player.clubs : [...DefaultClubs];
    this.disabled = false;

    this.currentClub = this.clubs[0]; // select first
    this.scorecard = new Map();
    this.start = new THREE.Vector3(0, 0, 0);
  }

  hasFinishedHole(holeNumber: string) {
    return this.scorecard.has(`${holeNumber}`);
  }

  resetPositions(holeStart: THREE.Vector3, holePin: THREE.Vector3, holeAim?: THREE.Vector3) {
    // TODO: autoselect club based on aim distance?
    this.currentClub = this.clubs[0];
    this.previousStart = undefined;
    this.originalStart = holeStart.clone();
    this.start = holeStart.clone();
    this.pin = holePin.clone();
    
    this.originalAim = holeAim?.clone();
    this.aim = holeAim?.clone();
  }
}
import { UIHazardDialog } from '@/ui/UIHazardDialog';
import { QualityMode } from '@/utils/quality';
import { type World } from '@dimforge/rapier3d-compat';
import {
  THREE,
  app,
  AimPoint,
  CourseLight,
  CourseLoader,
  CourseGame,
  CourseKeyboardControls,
  GolfBall,
  ShotPerspectiveCamera,
  UICourseMap,
  UIShotData,
  UIRangeFinder,
  UIPlayerMenu,
  UIStats,
  UILoadingScreen,
  VolumetricClouds,
  generateSetupData,
  UIMainMenu,
  FuseRenderer,
  UIScorecard,
  AudioPlayer,
  SkyBox,
  CourseLightOptions,
  NetClient,
  GameSync,
  UILobby,
  type UILobbyJoinParams,
  type UILobbyCourse,
 } from '@opengolfsim/fuse';

const HoleOutSound = '../sounds/holeout.wav';
const GroundThudSound = '../sounds/thud.wav';
const Ktx2Path = '../ktx2/';

const gameContext: {
  isReady: boolean,
  startPoint: THREE.Vector3,
  aimPoint: THREE.Vector3,
  qualityLevel: QualityMode,
  // Environment
  timer: THREE.Timer,
  world?: World;
  scene?: THREE.Scene;
  renderer?: FuseRenderer,
  golfBall?: GolfBall,
  lightGroup?: CourseLight,
  fog?: THREE.Fog,  
  clouds?: VolumetricClouds,

  // Course Data
  setupData?: OpenGolfSim.SetupData,
  gameData?: OpenGolfSim.GameData,
  course?: CourseLoader,
  game?: CourseGame,
  
  // Controls
  camera?: ShotPerspectiveCamera,
  controls?: CourseKeyboardControls
  visualAimPoint?: AimPoint,
  
  // Audio
  audioPlayer?: AudioPlayer,
  // UI
  shotData?: UIShotData,
  courseMap?: UICourseMap,
  playerMenu?: UIPlayerMenu,
  mainMenu?: UIMainMenu,
  loadingScreen?: UILoadingScreen,
  rangeFinder?: UIRangeFinder,
  stats?: UIStats,
  dialogs: {
    scorecard?: UIScorecard,
    hazard?: UIHazardDialog,
  },
  // Multiplayer
  net?: NetClient,
  gameSync?: GameSync,
  lobby?: UILobby,
  clientId?: string,
  localPlayerIds?: string[],
  /** true when a host app (OGS Desktop) supplied the players and their clubs */
  playersFromHost?: boolean,
  /** true once the lobby closed and the round is under way */
  roundStarted?: boolean,
  // true while the ball is flying a re-simulated remote shot (not a real local
  // shot) — GameSync must not report its landing as our own result
  replayingRemoteShot?: boolean,
  // State
  distanceToAim: number,
  heightToAim: number,
} = {
  isReady: false,
  timer: new THREE.Timer(),
  startPoint: new THREE.Vector3(0, 0, 0),
  aimPoint: new THREE.Vector3(0, 0, 0),
  qualityLevel: QualityMode.Medium,
  distanceToAim: 0,
  heightToAim: 0,
  dialogs: {}
};

const defaultSkyColor = 'rgb(177, 205, 236)';
const defaultFogColor = 'rgb(255, 247, 224)';
const defaultCloudColor = 'rgb(255, 255, 255)';
// const lightColor = new THREE.Color('rgb(255, 247, 224)');


function launchShot(shot: OpenGolfSim.Shot) {
  if (!gameContext.golfBall) return;

  // The lobby covers a round we're about to abandon — a swing while it's up
  // shouldn't be played into that round behind it.
  if (gameContext.lobby?.isOpen) {
    console.log('[net] lobby is open — shot ignored');
    return;
  }

  // Multiplayer: block input when it isn't one of our players' turn.
  if (gameContext.net && gameContext.game && !gameContext.game.isLocalTurn) {
    console.log('[net] not your turn — shot ignored');
    return;
  }

  if (shot.ballSpeed && !gameContext.golfBall.isShotActive) {
    // Multiplayer: tell everyone else to fly this exact shot live (before we
    // launch it locally), so remote clients see the ball in the air in sync
    // instead of waiting for it to land.
    if (gameContext.net && gameContext.game?.isLocalTurn) {
      gameContext.net.sendShotLaunch(gameContext.game.activePlayer.id, {
        shot,
        start: gameContext.startPoint.toArray() as [number, number, number],
        aim: gameContext.aimPoint.toArray() as [number, number, number],
      });
    }

    // this is a real local shot, so GameSync should report its result
    gameContext.replayingRemoteShot = false;
    // covers keyboard test shots too, which never reach app.on('shot')
    removeMultiplayerButton();
    gameContext.shotData?.updateShotData(shot);
    gameContext.golfBall.launchShot(shot);

    // tracking scale controls how long we wait before tracking a shot between (0-150 MPH)
    const trackingScale = Math.min(shot.ballSpeed / 150, 1);
    gameContext.camera?.setTracking(true, trackingScale);
  }
}

/**
 * A remote player swung — reproduce their shot on our ball so we watch it fly
 * live (same physics, same camera-tracking as a local shot). Scoring still
 * arrives authoritatively via GameSync's 'shot' handler when it lands.
 */
function flyRemoteShot(launch: { shot: OpenGolfSim.Shot, start: [number, number, number], aim: [number, number, number] }) {
  if (!gameContext.golfBall || !gameContext.game) return;
  if (gameContext.golfBall.isShotActive) return; // already flying (rare race)

  const start = new THREE.Vector3().fromArray(launch.start);
  const aim = new THREE.Vector3().fromArray(launch.aim);
  const pin = gameContext.game.activeHole.waypoints.get('pin');

  // Mark this as a replay so GameSync never reports its landing as our own shot
  // (the authoritative result comes from the shooter). Must be set before launch.
  gameContext.replayingRemoteShot = true;

  gameContext.startPoint.copy(start);
  gameContext.aimPoint.copy(aim);
  gameContext.golfBall.reset(aim, start, pin);
  gameContext.camera?.setPositions(start, aim);

  gameContext.shotData?.updateShotData(launch.shot);
  gameContext.golfBall.launchShot(launch.shot);

  const trackingScale = Math.min((launch.shot.ballSpeed || 100) / 150, 1);
  gameContext.camera?.setTracking(true, trackingScale);
}

function setupNextShot() {
  if (!gameContext.game) return;
  
  gameContext.camera?.setTracking(false);
  gameContext.startPoint.copy(gameContext.game.startPoint());
  gameContext.aimPoint.copy(gameContext.game.aimPoint());

  gameContext.camera?.setPositions(gameContext.startPoint, gameContext.aimPoint);
  if (gameContext.camera) {
    gameContext.course?.updateActiveGreen(gameContext.camera, gameContext.game.getActiveHoleNumber());
  }

  // recreate ball after each shot to ensure physics are fully reset
  gameContext.golfBall?.reset(gameContext.aimPoint, gameContext.startPoint, gameContext.game.activeHole.waypoints.get('pin'));

  aimPointUpdated(true);

  gameContext.clouds?.update();

  gameContext.courseMap?.updatePosition(gameContext.startPoint, gameContext.game.pinPoint());
  gameContext.courseMap?.updateHole(gameContext.game.activeHole);

  gameContext.game.autoSelectClub();
  gameContext.playerMenu?.update(gameContext.game.activePlayer);
  app.sendPlayerUpdate(gameContext.game.activePlayer, gameContext.startPoint.toArray());

}

async function setupRenderer() {
  THREE.ColorManagement.enabled = true;
  
  const canvas = document.getElementById('canvas');
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) throw new Error('Unable to find canvas in HTML. Make sure you create a root canvas element (e.g. <canvas id="canvas"></canvas>)');
  gameContext.renderer = new FuseRenderer({
    canvas,
    renderMode: 'webgpu',
    qualityLevel: gameContext.qualityLevel,
    antialias: true // gameContext.qualityLevel >= QualityMode.Medium
  });

  await gameContext.renderer.init();

  let maxPixelRatio = Math.min(window.devicePixelRatio, 1);
  if (gameContext.qualityLevel >= QualityMode.High) {
    maxPixelRatio = Math.min(window.devicePixelRatio, 2);
  }
}

async function setupScene() {
  const skyType = gameContext.course?.sceneSettings?.sky?.type;
  const cloudSettings = gameContext.course?.sceneSettings?.sky?.clouds;

  const skyColor = new THREE.Color(cloudSettings?.skyColor ?? defaultSkyColor);
  const fogColor = new THREE.Color(cloudSettings?.fogColor ?? defaultFogColor);
  const cloudColor = new THREE.Color(cloudSettings?.cloudColor ?? defaultCloudColor);

  // Base scene
  // TODO: move to course loader?
  gameContext.scene = new THREE.Scene(); 


  // Main Camera
  if (!gameContext.renderer) {
    throw new Error('Renderer does not exist!');
  }
  if (!gameContext.course) {
    throw new Error('Course object does not exist!');
  }
  const ground = gameContext.course.getGroundMeshes();
  gameContext.camera = new ShotPerspectiveCamera(
    {
      scene: ground,
      autoPosition: true,
      cameraOffsetX: (gameContext.setupData?.cameraOffset ? -(gameContext.setupData.cameraOffset / 100) : 0),
    }
  );
  
  if (gameContext.setupData?.qualityLevel && gameContext.setupData?.qualityLevel > QualityMode.Medium) {
    gameContext.renderer.setupPostProcessing(gameContext.scene, gameContext.camera);
  }

  // Aim point
  gameContext.visualAimPoint = new AimPoint(gameContext.camera, {
    units: gameContext.setupData?.units
  });
  await gameContext.visualAimPoint.load();
  gameContext.scene.add(gameContext.visualAimPoint.object);

  // Course Map
  if (!gameContext.course.courseMap) {
    throw new Error('Must pass a map image');
  }
  gameContext.courseMap = new UICourseMap({
    units: gameContext.setupData?.units,
    holes: gameContext.course?.holes,
    map: gameContext.course.courseMap,
    worldSize: gameContext.course.courseSize
  });
  gameContext.courseMap.on('holeChange', (hole) => {
    gameContext.game?.switchHole(hole);
    setupNextShot();
  });

  // Controls
  gameContext.controls = new CourseKeyboardControls({ testShots: true });
  gameContext.controls.on('aim', aimKeys => {
    if (gameContext.camera) gameContext.camera.aimKeys = aimKeys;
  });
  gameContext.controls.on('testShot', launchShot);
  gameContext.controls.on('toggleStats', () => gameContext.stats?.toggle());


  let lightOptions: CourseLightOptions = {
    qualityLevel: gameContext.qualityLevel,
    color: new THREE.Color('#fffac0'),
    directional: { enabled: true, intensity: 1.1 },
    ambient: { enabled: true, intensity: 0.8 }
  };
  
  
  // QUESTION: move to course loader?
  if (skyType === 'clouds') {
    // Sky/Clouds
    gameContext.scene.background = skyColor;
    gameContext.clouds = new VolumetricClouds(gameContext.camera, {
      radius: 800,
      scale: cloudSettings?.scale ?? 3,
      opacity: cloudSettings?.opacity ?? 0.8,
      density: cloudSettings?.density ?? 0.5,
      cloudColor,
      fogColor,
      skyColor,
      position: new THREE.Vector3(0, -40, 0)
    });
    gameContext.scene.add(gameContext.clouds.object);
    gameContext.renderer.generateEnvironment(gameContext.scene, gameContext.clouds.object);

    gameContext.fog = new THREE.Fog(fogColor, 300, 800);
    gameContext.scene.fog = gameContext.fog;

  } else if (skyType === 'hdri') {
    const parser = gameContext.course?.gltf?.parser;
    if (parser) {
      const skyboxDef = (parser.json?.images || []).find(
        (img: any) => img.extras?.type === 'hdri'
      );
      const buffer: ArrayBuffer = await parser.getDependency('bufferView', skyboxDef.bufferView);
      const box = new SkyBox();
      box.load(gameContext.scene, buffer);
    }
  }
  
  gameContext.lightGroup = new CourseLight(lightOptions);
  gameContext.scene.add(gameContext.lightGroup);
  

  if (gameContext.renderer.environment) {
    gameContext.course.updateEnvironment(gameContext.renderer.environment);
  }

}

/**
 * Manually place ball
 */
function adjustStartPoint(newPosition: THREE.Vector3) {
  console.log('update start', newPosition);
  const ground = gameContext.course?.getGroundY(newPosition.x, newPosition.z);
  if (ground) {
    newPosition.y = ground.y;
  }
  gameContext.game?.updateStartPoint(newPosition);
  setupNextShot();
}

/**
 * Adjust the aim point
 */
function adjustAimPoint(newPosition: THREE.Vector3) {
  if (!gameContext.game) throw new Error('Course game not setup yet');
  // console.log('update aim', newPosition);
  const ground = gameContext.course?.getGroundY(newPosition.x, newPosition.z);
  if (ground) {
    newPosition.y = ground.y;
  }
  gameContext.aimPoint.copy(newPosition);
  gameContext.camera?.setPositions(gameContext.game.startPoint(), gameContext.aimPoint);

  aimPointUpdated(true);
}

/**
 * Called after the aim point has changed
 */
function aimPointUpdated(forced = false) {
  gameContext.distanceToAim = gameContext.startPoint.distanceTo(gameContext.aimPoint);
  gameContext.heightToAim = gameContext.aimPoint.y - gameContext.startPoint.y;
  gameContext.rangeFinder?.update(gameContext.distanceToAim, gameContext.heightToAim);
  gameContext.golfBall?.aimAt(gameContext.aimPoint);
  if (forced) {
    gameContext.visualAimPoint?.reset(gameContext.aimPoint);
  }
}


/**
 * Launched by a host app (OGS Desktop). Solo is the default and behaves exactly
 * as it always has — the course loads immediately, no extra clicks. Multiplayer
 * is opt-in via a button on the loading screen.
 *
 * There is no URL to put a room code in here, and the roster has to be settled
 * *before* CourseGame is built, so joining reloads the page with the intent
 * stashed in sessionStorage. That's safe because Desktop re-sends `setup`
 * immediately on reload (measured 2026-07-25: 0.0s into the new page load).
 */
/**
 * True when this page was launched as the dedicated multiplayer entry (the
 * library tile) rather than as a course. Detected by path so it survives
 * whatever the host app does with query strings.
 */
function isMultiplayerEntry(): boolean {
  return window.location.pathname.includes('/multiplayer/')
    || new URLSearchParams(window.location.search).get('mp') === '1';
}

/**
 * The fuse courses this build can play, straight from the host app's own
 * catalog (same origin — the dev server proxies `/api` to OpenGolfSim). Falls
 * back to the bundled games.json so a plain browser still gets a picker.
 */
async function fetchCourses(): Promise<UILobbyCourse[]> {
  const sources = ['/api/courses/home?platform=darwin&fuse=1', '../games.json'];
  for (const source of sources) {
    try {
      const response = await fetch(source);
      if (!response.ok) continue;
      const data = await response.json();
      const courses = (data.courses ?? data.games ?? [])
        .filter((entry: any) => entry.courseUrl && entry.gameMode === 2)
        .map((entry: any) => ({ title: entry.title, url: entry.courseUrl }));
      if (courses.length) return courses;
    } catch {
      // try the next source
    }
  }
  return [];
}

let setupHandled = false;

async function handleSetup(payload: any) {
  console.log('Received setup event', payload);
  if (!payload?.setupData) throw new Error('No setupData received in setup event!');
  if (!payload?.gameData) throw new Error('No gameData received in setup event!');
  // The host app may send `setup` more than once per page load. Loading the
  // course twice would build a second scene, ball and CourseGame over the top
  // of the first — take the first payload and ignore the rest.
  if (setupHandled) {
    console.warn('[setup] ignoring a repeat setup event — the round is already loading');
    return;
  }
  setupHandled = true;
  gameContext.setupData = payload?.setupData as OpenGolfSim.SetupData;
  gameContext.gameData = payload?.gameData as OpenGolfSim.GameData;
  // the host app owns the player list here — real names, real club distances
  gameContext.playersFromHost = true;

  const intent = takeLobbyIntent();
  if (intent) {
    // we reloaded out of a solo round to join a room; go straight back to it
    openLobby(gameContext.gameData.courseUrl ?? '', new URLSearchParams(), intent);
    return;
  }

  // Launched from the Multiplayer tile: no course attached, so open the lobby
  // and let it pick one. Nothing is built until the roster is settled.
  if (isMultiplayerEntry()) {
    startMultiplayerEntry();
    return;
  }

  preLoad();
  addMultiplayerButton();
}

/**
 * The multiplayer entry page, from either side: OGS Desktop (which supplies the
 * players) or a plain browser (which doesn't, so we invent one — this is how the
 * remote player joins). Opens the lobby with a course picker and builds nothing
 * until the roster is settled.
 */
async function startMultiplayerEntry() {
  const params = new URLSearchParams(window.location.search);
  if (!gameContext.setupData) {
    gameContext.setupData = generateSetupData(1);
    const name = params.get('name');
    if (name && gameContext.setupData.players[0]) {
      gameContext.setupData.players[0].name = name;
    }
  }
  gameContext.gameData ??= { id: 'mp', courseUrl: '', gameMode: 2 };
  openLobby('', params, undefined, await fetchCourses());
}

/** Remove every opt-in button, however many somehow got added. */
function removeMultiplayerButton() {
  document.querySelectorAll('.mp-opt-in').forEach((button) => button.remove());
}

/** Opt into multiplayer from a host-launched (solo) round. */
function addMultiplayerButton() {
  removeMultiplayerButton(); // never stack two
  const button = document.createElement('button');
  button.textContent = 'Multiplayer';
  button.className = 'mp-opt-in';
  button.addEventListener('click', () => {
    removeMultiplayerButton();
    openLobby(gameContext.gameData?.courseUrl ?? '', new URLSearchParams());
  });
  document.body.append(button);
}

async function setupCourse() {
  if (!app.world) {
    throw new Error('Physics world does not exist');
  }
  if (!gameContext?.setupData) {
    throw new Error('Missing setupData!');
  }
  if (!gameContext?.gameData?.courseUrl) {
    throw new Error('Missing a courseUrl to a GLB in the gameData object');
  }
  if (typeof gameContext.setupData?.qualityLevel !== 'undefined') {
    gameContext.qualityLevel = gameContext.setupData.qualityLevel;
  }
  
  await setupRenderer();
  
  if (!gameContext.renderer) {
    throw new Error('Missing renderer!');
  }
  // load course details and meshes
  gameContext.course = new CourseLoader(
    app.world,
    app.rapier,
    gameContext.renderer,
    {
      setupData: gameContext.setupData,
      qualityLevel: gameContext.qualityLevel,
      manager: gameContext.loadingScreen?.manager,
      meshLoaderOptions: { ktx2Path: Ktx2Path }
    }
  );

  await gameContext.course.load(gameContext.gameData.courseUrl);
  
  console.log('Course loaded', gameContext.course);
  console.log('Course settings', gameContext.course.sceneSettings);
  if (!gameContext.course.scene) throw new Error('Unable to load course scene');

  console.log('Loading audio files...');
  // load audio
  gameContext.audioPlayer = new AudioPlayer();
  await gameContext.audioPlayer.load(HoleOutSound);  
  await gameContext.audioPlayer.load(GroundThudSound);

  console.log('Creating base scene...');
  // create the initial scene
  await setupScene();
  if (!gameContext.scene) {
    throw new Error('Unable to create main scene (does not exist)');
  }
  
  console.log('Adding course scene...');
  // add loaded course to the scene
  gameContext.scene?.add(gameContext.course.scene);


  console.log('Create golf ball...');
  // create the golf ball
  gameContext.golfBall = new GolfBall(gameContext.scene, app.world, app.rapier, {
    setupData: gameContext.setupData,
    groundMeshes: gameContext.course.getGroundMeshes()
  });
  gameContext.golfBall.on('landed', (velocity: number) => {
    gameContext.audioPlayer?.play(GroundThudSound, velocity);
  });
  gameContext.golfBall.on('holedOut', () => {
    gameContext.audioPlayer?.play(HoleOutSound);
  });
  gameContext.golfBall.on('shotEnded', (result) => {
    app.sendShotResult(
      {
        shot: gameContext.golfBall?.lastShot,
        stats: gameContext.golfBall?.stats,
        player: gameContext.game?.activePlayer.player,
        club: gameContext.game?.activePlayer?.currentClub,
      }
    );
  });
  
  console.log('Setup game logic...');
  // setup course game controller
  gameContext.game = new CourseGame(gameContext.course, gameContext.golfBall, {
    setupData: gameContext.setupData,
    localPlayerIds: gameContext.localPlayerIds,
    networked: !!gameContext.net,
  });
  // In multiplayer, GameSync routes shots through the relay and applies them on
  // the echo (CourseGame's built-in ball adapter is off when networked).
  if (gameContext.net) {
    gameContext.gameSync = new GameSync(gameContext.game, gameContext.net, gameContext.golfBall, {
      isReplay: () => !!gameContext.replayingRemoteShot,
    });

    // Live shots — when a remote player swings, fly the same shot on our ball so
    // we watch it in the air in sync (our own swings already fired locally, so
    // skip those). GameSync handles the authoritative score when it lands.
    gameContext.net.on('launch', ({ playerId, launch }) => {
      if (!gameContext.game || gameContext.game.localPlayerIds.has(playerId)) return;
      flyRemoteShot(launch);
    });
  }
  gameContext.game?.on('nextShot', (player) => {
    console.log(`A new player (${player.name}) is up!`);
    setupNextShot();
  });
  gameContext.game?.on('roundEnded', () => {
    console.log(`The round is over!`);
    gameContext.dialogs.scorecard?.open();
  });

  gameContext.shotData = new UIShotData('#shot-data', { units: gameContext.setupData?.units });
  gameContext.rangeFinder = new UIRangeFinder('#top-center', { units: gameContext.setupData?.units });
  gameContext.mainMenu = new UIMainMenu('#top-left');
  
  gameContext.dialogs.scorecard = new UIScorecard('#scorecard', {
    players: gameContext.game?.players || [],
    holes: gameContext.course.holes
  });
  gameContext.dialogs.hazard = new UIHazardDialog('#hazard', {});

  gameContext.mainMenu.on('exit', () => app.exit())

  gameContext.playerMenu = new UIPlayerMenu('#top-left', { players: gameContext.game?.players || [] });
  gameContext.playerMenu.on('showScorecard', () => {
    // gameContext.dialogs.scorecard?.updateScores();
    gameContext.dialogs.scorecard?.open();
  });
  gameContext.playerMenu.on('selectPlayer', player => {
    // handle player changed
    console.log('select player', player);
    if (gameContext.game) {
      gameContext.game.selectPlayer(player);
    }
  });
  gameContext.playerMenu.on('selectClub', club => {
    console.log('select club', club);
    // handle club change
    if (gameContext.game) {
      gameContext.game.selectClub(club);
      gameContext.playerMenu?.update(gameContext.game.activePlayer);
      app.sendPlayerUpdate(gameContext.game.activePlayer, gameContext.startPoint.toArray());
    }
  });

  console.log('Setting up first shot...');
  // gameContext.camera?.setScene(gameContext.course.getGroundMeshes());
  setupNextShot();

  gameContext.courseMap?.on('updateAim', adjustAimPoint);
  gameContext.courseMap?.on('updateStart', adjustStartPoint);

  if (gameContext.camera) {
    console.log('Precompiling shaders...');
    await gameContext.renderer.compile(gameContext.scene, gameContext.camera);  
    // DEBUG: per-mesh probe to find which material hangs pipeline creation
    // await gameContext.renderer.compileProbe(gameContext.scene, gameContext.camera);
    console.log('Done compiling shaders!');
  }
}

/**
 * Sets up loading screen and kicks off loading of the course and building the scene
 */
function preLoad() {
  // allow override with query param
  const params = new URLSearchParams(window.location.search);
  const qualityParam = params.get('quality');
  if (qualityParam) {
    gameContext.qualityLevel = parseInt(qualityParam, 10);
    if (gameContext.setupData) gameContext.setupData.qualityLevel = gameContext.qualityLevel;
  }
  const practiceParam = params.get('practice');
  if (practiceParam) {
    const practiceMode = practiceParam === '1' || practiceParam === 'true';
    if (gameContext.setupData) gameContext.setupData.practiceMode = practiceMode;
  }

  console.log('[debug] Setup Data', gameContext.setupData);
  gameContext.loadingScreen = new UILoadingScreen(document.body, { loadingPrefix: 'Loading Course' });
  gameContext.loadingScreen.on('load', (error) => {
    gameContext.stats = new UIStats('#render-stats', { hidden: false, renderer: gameContext.renderer?.renderer }); // start hidden (press S to toggle)
    if (!error) {
      requestAnimationFrame(animate);
      gameContext.isReady = true;
    }
  });
  // The loading screen shows only the message, and a host app gives us no
  // console — send the stack to it so the failure is diagnosable from its log.
  gameContext.loadingScreen.load(async () => {
    try {
      await setupCourse();
    } catch (err) {
      app.log(`[fuse] course setup failed: ${(err as Error)?.stack ?? err}`);
      throw err;
    }
  });
  document.body.style.opacity = '1';
  gameContext.timer.connect(document);  
}


function animate(animDelta: number) {
  requestAnimationFrame(animate);

  gameContext.stats?.begin();
  const delta = gameContext.timer.getDelta();
  
  if (gameContext.golfBall) {
    gameContext.golfBall.update(delta);
  }

  gameContext.renderer?.clear();

  gameContext.controls?.update(delta);
  gameContext.clouds?.update(delta);

  if (gameContext.camera && gameContext.golfBall && gameContext.isReady) {
    gameContext.course?.update(delta, gameContext.camera, gameContext.golfBall, gameContext.game?.getActiveHoleNumber());
  }

  // gameContext.game?.update(delta);

  if (gameContext.scene && gameContext.game) {
    const game = gameContext.game;
    const ball = gameContext.golfBall;
    // While a shot is in the air the map should track the ball itself, not the
    // lie it was struck from. Between shots they're the same point.
    const ballPosition = ball?.isShotActive && ball.object
      ? ball.object.position
      : gameContext.startPoint;

    gameContext.courseMap?.render(
      gameContext.scene,
      game.activeHole,
      {
        ball: ballPosition,
        aim: gameContext.aimPoint,
        // every ball still in play on this hole, so you can see where the group is
        players: game.players
          .filter((player) => !player.disabled)
          .map((player) => ({
            name: player.name,
            position: player.start,
            isActive: player.id === game.activePlayer.id,
          })),
      }
    );
  }

  if (gameContext.golfBall) {
    
    gameContext.shotData?.updateShotResult(gameContext.golfBall.stats);
    
    if (gameContext.scene) {
      if (gameContext.golfBall.isShotActive && gameContext.golfBall.object) {
        gameContext.camera?.track(delta, gameContext.startPoint, gameContext.golfBall.object.position);
      } else {
        const aimChanged = gameContext.camera?.update(delta, gameContext.startPoint, gameContext.aimPoint);
        if (aimChanged) {
          aimPointUpdated();
        }
      }

      if (gameContext.camera) {
        gameContext.renderer?.render(gameContext.scene, gameContext.camera, gameContext.fog);
      }
    }
  }

  gameContext.visualAimPoint?.update(
    gameContext.aimPoint,
    gameContext.distanceToAim,
    gameContext.heightToAim,
    !!gameContext.golfBall?.isShotActive
  );

  gameContext.stats?.end();
  gameContext.timer.update(animDelta);
}

async function initializeDebug() {
  // used for testing an example course in the browser
  // pass a courseUrl as a query param to load a course
  const params = new URLSearchParams(window.location.search);
  // Joining a room without naming a course is allowed — we adopt whatever the
  // room is already playing, so nobody has to pass around an exact GLB url.
  const courseUrl = params.get('courseUrl') ?? '';
  if (!courseUrl && !params.get('room')) {
    throw new Error('No courseUrl provided');
  }
  gameContext.setupData = generateSetupData(1);
  // let ?name= rename the local player so tabs are distinguishable
  const name = params.get('name');
  if (name && gameContext.setupData.players[0]) {
    gameContext.setupData.players[0].name = name;
  }
  gameContext.gameData = { id: 'web', courseUrl, gameMode: 2 };
  document.getElementById('debug-message')?.setAttribute('style', 'display: block;');

  // Multiplayer opens the lobby instead of loading straight into the course:
  //   ?mp=1                 -> lobby, fill in the room code by hand
  //   ?room=<code>          -> lobby, joined automatically
  // (optional &server=host:port &secret= &name=). No ?room/?mp loads as before.
  if (params.get('room') || params.get('mp') === '1') {
    openLobby(courseUrl, params);
  } else {
    preLoad();
  }
}

const LOBBY_STORAGE_KEY = 'ogs.lobby';

/** Remember the last name/room/server so rejoining is one click. */
function rememberLobby(values: UILobbyJoinParams) {
  try {
    const { name, room, server } = values; // never persist the secret
    localStorage.setItem(LOBBY_STORAGE_KEY, JSON.stringify({ name, room, server }));
  } catch { /* private mode — prefills just won't stick */ }
}
function recallLobby(): Partial<UILobbyJoinParams> {
  try {
    return JSON.parse(localStorage.getItem(LOBBY_STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

/**
 * Joining has to happen before CourseGame is built, but a host-launched round is
 * already under way by the time you can click anything — so the lobby stashes
 * where you're going and reloads. Session-scoped: it must not outlive the window.
 */
const LOBBY_INTENT_KEY = 'ogs.lobby.intent';

function storeLobbyIntent(values: UILobbyJoinParams) {
  try {
    sessionStorage.setItem(LOBBY_INTENT_KEY, JSON.stringify(values));
  } catch { /* nothing to do — the reload will just land back on solo */ }
}
/** Read the pending intent and clear it, so a later reload doesn't re-join. */
function takeLobbyIntent(): UILobbyJoinParams | undefined {
  try {
    const raw = sessionStorage.getItem(LOBBY_INTENT_KEY);
    sessionStorage.removeItem(LOBBY_INTENT_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Show the multiplayer lobby: pick a room, watch players arrive, start the round
 * together, and leave again. Query params only seed the form (browser); a host
 * app supplies the players instead, and `resume` is a join we already committed
 * to before reloading.
 */
function openLobby(
  courseUrl: string,
  params: URLSearchParams,
  resume?: UILobbyJoinParams,
  courses?: UILobbyCourse[],
) {
  const saved = recallLobby();
  const hostPlayers = gameContext.playersFromHost
    ? (gameContext.setupData?.players ?? []).map((player) => player.name)
    : undefined;
  const lobby = new UILobby(document.body, {
    courseName: courseUrl.split('/').pop(),
    hostPlayers,
    courses,
    defaults: {
      name: resume?.name || params.get('name') || saved.name || '',
      room: resume?.room || params.get('room') || saved.room || '',
      server: resume?.server || params.get('server') || saved.server || 'localhost:8080',
      secret: resume?.secret || params.get('secret') || '',
    },
  });
  gameContext.lobby = lobby;
  document.body.style.opacity = '1'; // preLoad normally does this, but that's post-Start

  lobby.on('join', (values) => {
    // A host-launched round is already loading behind this overlay; reload so we
    // come back clean and can build the game from the server roster instead.
    // The multiplayer entry has nothing loaded yet, so it needs no reload.
    if (gameContext.playersFromHost && !resume && !isMultiplayerEntry()) {
      storeLobbyIntent(values);
      window.location.reload();
      return;
    }
    joinRoom(values, courseUrl);
  });
  lobby.on('start', () => gameContext.net?.sendStart());
  lobby.on('leave', () => leaveRoom());
  lobby.open();

  // Already committed (we reloaded to get here), or ?room= says "I know where
  // I'm going" — either way, connect straight away.
  if (resume) {
    joinRoom(resume, courseUrl);
  } else if (params.get('room') && lobby.values.name) {
    joinRoom(lobby.values, courseUrl);
  }
}

/**
 * Connect to the relay and sit in the lobby. When someone hits Start the server
 * broadcasts the final roster and we build the game from it, so every client
 * shares one player list (and therefore one turn order). The shot wiring lives
 * in GameSync, created in setupCourse.
 */
function joinRoom(values: UILobbyJoinParams, courseUrl: string) {
  const lobby = gameContext.lobby;
  rememberLobby(values);

  // Picked in the lobby (the Multiplayer tile), handed to us by the host app, or
  // empty — in which case we inherit whatever the room is already playing.
  const course = values.courseUrl || courseUrl;
  if (course) {
    gameContext.gameData = { ...(gameContext.gameData ?? { id: 'mp', gameMode: 2 }), courseUrl: course };
  }

  // A host app already sent us real players with real club distances — keep them
  // exactly as they are. Only the browser demo invents players, where one field,
  // comma separated, covers the garage case: "Lake, Sarah" seats two local
  // players on this machine, both owned by (and played from) this client.
  let setupData = gameContext.setupData!;
  if (!gameContext.playersFromHost) {
    const names = values.name.split(',').map((n) => n.trim()).filter(Boolean);
    setupData = generateSetupData(names.length || 1);
    names.forEach((n, i) => { setupData.players[i].name = n; });
    gameContext.setupData = setupData;
  }

  const net = new NetClient(`ws://${values.server}`, {
    roomCode: values.room,
    roomSecret: values.secret,
    courseUrl: course,
    players: setupData.players,
  });
  gameContext.net = net;
  (window as any).ogsNet = net;
  lobby?.setConnecting(values.room);

  net.on('open', () => console.log('[net] connected, joining room', values.room));
  net.on('joined', (m) => {
    gameContext.clientId = m.clientId;
    console.log('[net] joined as', m.clientId);
    // Joined without naming a course: play whatever the room is playing. Saves
    // the other players from having to pass around an exact GLB url.
    if (!course && m.room?.courseUrl) {
      console.log('[net] adopting the room course:', m.room.courseUrl);
      gameContext.gameData = { ...gameContext.gameData!, courseUrl: m.room.courseUrl };
      lobby?.setCourseName(m.room.courseUrl.split('/').pop() ?? '');
    }
  });
  net.on('error', (msg) => {
    console.warn('[net] error:', msg);
    lobby?.setError(msg);
  });
  net.on('close', () => {
    console.log('[net] disconnected');
    if (!gameContext.roundStarted) lobby?.setError('Disconnected from the relay.');
  });

  net.on('roster', (m) => {
    console.log(`[net] roster (${m.roster.length}):`, m.roster.map((p) => `${p.id} (${p.name})`));
    if (gameContext.roundStarted) return; // the roster is frozen once we're playing
    lobby?.setRoster(values.room, m.roster, gameContext.clientId);
  });

  net.on('started', (m) => {
    if (gameContext.roundStarted) return;
    gameContext.roundStarted = true;
    // Replace our local player list with the full server roster (namespaced ids).
    gameContext.setupData!.players = m.roster.map((p) => ({ name: p.name, id: p.id, clubs: p.clubs }));
    gameContext.localPlayerIds = m.roster
      .filter((p) => p.ownerId === gameContext.clientId)
      .map((p) => p.id);
    console.log('[net] starting — this client owns', gameContext.localPlayerIds);
    lobby?.setPlaying(values.room, m.roster.length);
    preLoad();
  });

  net.connect();
}

/**
 * Leave the room. From the lobby that's instant (drop the socket, show the form
 * again). Mid-round there's a loaded course, a physics world and a CourseGame
 * built around a frozen roster, so we take the honest way out and reload back
 * into the lobby.
 */
function leaveRoom() {
  // drop our handlers first so the resulting 'close' isn't reported as an error
  gameContext.net?.removeAllListeners();
  gameContext.net?.leave();
  if (gameContext.roundStarted) {
    // Host-launched: reload bare, so `setup` arrives again and we land back in a
    // normal solo round. Adding query params here would send us down the browser
    // debug path, which needs a ?courseUrl we don't have.
    if (gameContext.playersFromHost) {
      window.location.reload();
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.delete('room'); // don't auto-rejoin what we just left
    url.searchParams.set('mp', '1');
    window.location.href = url.toString();
    return;
  }
  gameContext.net = undefined;
  gameContext.clientId = undefined;
  gameContext.lobby?.open();
  gameContext.lobby?.setStatus('Left the room.');
}

// listen for setup event from OpenGolfSim app
app.on('setup', handleSetup);
// Once a ball is struck the round is committed, so retire the multiplayer opt-in
// (switching now would throw the round away). Registered BEFORE launchShot:
// eventemitter3 runs listeners in order and stops at the first one that throws,
// so this must not sit downstream of the shot-handling code.
app.on('shot', removeMultiplayerButton);
// listen for shot event from OpenGolfSim app
app.on('shot', launchShot);

// initialize must be called before engaging physics/world
app.initialize(() => {
  // The multiplayer entry page in a plain browser: no host app will ever send
  // `setup`, so start it here. Under a host app, handleSetup does it instead.
  if (isMultiplayerEntry() && app.appType === 'web') {
    startMultiplayerEntry();
    return;
  }
  // if we passed a test course URL as a query param, we start in debug mode
  if (window.location.search) {
    initializeDebug();
  }
});
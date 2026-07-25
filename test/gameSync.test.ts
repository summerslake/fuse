import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import EventEmitter from 'eventemitter3';
// @ts-expect-error — plain JS server module, no types
import { createRelay } from '../server/relay.js';
import { NetClient } from '@/net/client';
import { GameSync } from '@/net/gameSync';
import { CourseGame } from '@/courses/game';
import { type Hole } from '@/courses/types';

/**
 * The headline Phase 3 test: two independent CourseGames, each driven only by
 * its own GameSync over a real relay, must stay perfectly in sync through a full
 * round. No browser — a fake ball just emits 'shotEnded'.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const club = { name: 'DR', id: 'DR', distance: 200 };

function makeCourse() {
  const holes = new Map<number, Hole>();
  holes.set(1, { number: '1', par: 3, waypoints: new Map([['tee', V(0, 0, 0)], ['aim', V(0, 0, 100)], ['pin', V(0, 0, 150)]]) });
  holes.set(2, { number: '2', par: 4, waypoints: new Map([['tee', V(0, 0, 0)], ['aim', V(0, 0, 120)], ['pin', V(0, 0, 200)]]) });
  return { holes } as any;
}

/** Fake GolfBall: an emitter with a positioned object; enough for GameSync. */
function makeBall() {
  const ball: any = new EventEmitter();
  ball.object = { position: new THREE.Vector3() };
  return ball;
}

let relay: any;
const nets: NetClient[] = [];

afterEach(async () => {
  for (const n of nets) n.close();
  nets.length = 0;
  if (relay) { await relay.close(); relay = null; }
});

function once(em: any, ev: string, timeout = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout '${ev}'`)), timeout);
    em.once(ev, (x: any) => { clearTimeout(t); resolve(x); });
  });
}
function waitForRoster(c: NetClient, n: number): Promise<any> {
  return new Promise((resolve) => {
    const h = (m: any) => { if (m.roster.length === n) { c.off('roster', h); resolve(m); } };
    c.on('roster', h);
  });
}

interface Side { net: NetClient; game: CourseGame; ball: any; clientId: string; }

async function setupSession(port: number): Promise<{ a: Side; b: Side }> {
  const mk = (name: string, id: string) => {
    const net = new NetClient(`ws://localhost:${port}`, {
      roomCode: 'g', courseUrl: 'c.glb', players: [{ name, id, clubs: [club] }],
    });
    nets.push(net);
    return net;
  };
  const netA = mk('Lake', 'a');
  const netB = mk('Brett', 'b');

  const jA = once(netA, 'joined');
  netA.connect();
  const joinedA = await jA;
  const rA = waitForRoster(netA, 2);
  const rB = waitForRoster(netB, 2);
  const jB = once(netB, 'joined');
  netB.connect();
  const joinedB = await jB;
  const roster = (await rA).roster;
  await rB;

  const build = (clientId: string) => {
    const ball = makeBall();
    const game = new CourseGame(makeCourse(), ball, {
      setupData: {
        units: 'imperial', practiceMode: false, puttingEnabled: false,
        gimmeDistances: [2, 4, 80], players: roster,
      } as any,
      localPlayerIds: roster.filter((p: any) => p.ownerId === clientId).map((p: any) => p.id),
      networked: true,
    });
    return { ball, game };
  };
  const a = { net: netA, clientId: joinedA.clientId, ...build(joinedA.clientId) };
  const b = { net: netB, clientId: joinedB.clientId, ...build(joinedB.clientId) };
  new GameSync(a.game, a.net, a.ball);
  new GameSync(b.game, b.net, b.ball);
  return { a, b };
}

/** Emit a shot on `shooter`'s ball and resolve once both clients have applied
 *  it. The turn advances deterministically inside applyShotResult — there is no
 *  separate 'turn' message to wait on. */
async function shoot(
  a: Side, b: Side, shooter: Side,
  opts: { pos: [number, number, number]; surface?: string; isHoled?: boolean },
) {
  // register both waiters BEFORE emitting so nothing is missed
  const waits = [once(a.net, 'shot'), once(b.net, 'shot')];
  shooter.ball.object.position.fromArray(opts.pos);
  shooter.ball.emit('shotEnded', {
    surface: opts.surface ? { type: opts.surface } : undefined,
    isHoled: !!opts.isHoled,
  });
  await Promise.all(waits);
}

const scores = (g: CourseGame) =>
  g.players.map((p) => [p.id, Object.fromEntries(p.scorecard)] as const);

describe('GameSync — two clients play a synced round', () => {
  it('keeps scorecards and away turn order identical across a full hole', async () => {
    relay = createRelay({ port: 0 });
    await relay.ready;
    const port = relay.wss.address().port as number;
    const { a, b } = await setupSession(port);

    const idA = a.game.players[0].id; // roster[0], owned by A
    const idB = a.game.players[1].id; // owned by B

    // both on the tee -> honors to A on both clients
    expect(a.game.activePlayer.id).toBe(idA);
    expect(b.game.activePlayer.id).toBe(idA);
    expect(a.game.isLocalTurn).toBe(true);
    expect(b.game.isLocalTurn).toBe(false);

    // A tees off to z=30 (120 from pin) -> B is now away (still on the tee, 150)
    await shoot(a, b, a, { pos: [0, 0, 30], surface: 'fairway' });
    expect(a.game.activePlayer.id).toBe(idB);
    expect(b.game.activePlayer.id).toBe(idB);
    expect(b.game.isLocalTurn).toBe(true);
    expect(a.game.players[0].scorecard.get('1')).toBe(1);

    // B tees off to z=50 (100 from pin) -> A (120) is farther again
    await shoot(a, b, b, { pos: [0, 0, 50], surface: 'fairway' });
    expect(a.game.activePlayer.id).toBe(idA);
    expect(b.game.activePlayer.id).toBe(idA);

    // A onto the green 2m from pin -> auto-putt 1 -> A holes out (1+1+1 = 3)
    await shoot(a, b, a, { pos: [0, 0, 148], surface: 'green' });
    expect(a.game.players[0].scorecard.get('1')).toBe(3);
    expect(a.game.players[0].disabled).toBe(true);
    expect(a.game.activePlayer.id).toBe(idB); // only B left on the hole
    expect(b.game.activePlayer.id).toBe(idB);

    // B onto the green 3m from pin -> auto-putt 2 -> B holes out (1+1+2 = 4)
    await shoot(a, b, b, { pos: [0, 0, 147], surface: 'green' });
    expect(a.game.players[1].scorecard.get('1')).toBe(4);

    // everyone holed out -> advance to hole 2, honors back to A, flags reset
    expect(a.game.activeHole.number).toBe('2');
    expect(b.game.activeHole.number).toBe('2');
    expect(a.game.activePlayer.id).toBe(idA);
    expect(b.game.activePlayer.id).toBe(idA);
    expect(a.game.players.every((p) => !p.disabled)).toBe(true);
    expect(b.game.players.every((p) => !p.disabled)).toBe(true);

    // the whole scorecard state matches across clients
    expect(scores(a.game)).toEqual(scores(b.game));
  });

  it('a shot for a player the sender does not own never reaches the other client', async () => {
    relay = createRelay({ port: 0 });
    await relay.ready;
    const port = relay.wss.address().port as number;
    const { a, b } = await setupSession(port);
    const idB = a.game.players[1].id; // owned by B, not A

    // Force A to (incorrectly) send a shot for B's player directly.
    let bApplied = false;
    b.net.on('shot', () => { bApplied = true; });
    a.net.sendShotResult(idB, { endPosition: [0, 0, 10], isHoled: false });
    await new Promise((r) => setTimeout(r, 150));
    expect(bApplied).toBe(false);
    expect(b.game.players[1].scorecard.size).toBe(0);
  });
});

describe('GameSync — isReplay guard', () => {
  it('never sends a result for a re-simulated remote shot, even once it is our turn', () => {
    const sent: Array<{ id: string }> = [];
    const fakeNet: any = new EventEmitter();
    fakeNet.sendShotResult = (id: string) => sent.push({ id });

    const ball: any = new EventEmitter();
    ball.object = { position: new THREE.Vector3(1, 2, 3) };

    // It IS our turn (the race: the turn has flipped to us by the time the
    // replayed ball lands). Only the replay flag should suppress the send.
    const game: any = { isLocalTurn: true, activePlayer: { id: 'me' }, applyShotResult() {} };
    let replaying = true;
    new GameSync(game, fakeNet, ball, { isReplay: () => replaying });

    ball.emit('shotEnded', { surface: { type: 'green' }, isHoled: false });
    expect(sent.length).toBe(0); // replay -> suppressed

    replaying = false;
    ball.emit('shotEnded', { surface: { type: 'green' }, isHoled: false });
    expect(sent).toEqual([{ id: 'me' }]); // real local shot -> sent
  });
});

import { describe, it, expect, afterEach } from 'vitest';
// @ts-expect-error — plain JS server module, no types
import { createRelay, PROTOCOL_VERSION as SERVER_VERSION } from '../server/relay.js';
import { NetClient } from '@/net/client';
import { PROTOCOL_VERSION as CLIENT_VERSION } from '@/net/types';

/**
 * End-to-end Phase 1 tests: the real browser NetClient talking to the real
 * relay over an actual WebSocket (Node has a global WebSocket). No browser.
 */

let relay: any;
const clients: NetClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  if (relay) { await relay.close(); relay = null; }
});

async function startRelay(opts: Record<string, unknown> = {}) {
  relay = createRelay({ port: 0, ...opts });
  await relay.ready;
  return relay.wss.address().port as number;
}

function makeClient(port: number, join: any) {
  const c = new NetClient(`ws://localhost:${port}`, join);
  clients.push(c);
  return c;
}

const playersFor = (name: string) => [{ name, id: 'player-1', clubs: [] }];

function once(em: any, ev: string, timeout = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for '${ev}'`)), timeout);
    em.once(ev, (x: any) => { clearTimeout(t); resolve(x); });
  });
}

function waitForRoster(c: NetClient, n: number, timeout = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for roster of ${n}`)), timeout);
    const h = (m: any) => {
      if (m.roster.length === n) { clearTimeout(t); c.off('roster', h); resolve(m); }
    };
    c.on('roster', h);
  });
}

/** Join two clients to the same room; resolve once both see the 2-player roster. */
async function joinTwo(port: number, room = 'garage', course = 'course.glb') {
  const c1 = makeClient(port, { roomCode: room, courseUrl: course, players: playersFor('A') });
  const c2 = makeClient(port, { roomCode: room, courseUrl: course, players: playersFor('B') });
  const j1 = once(c1, 'joined');
  c1.connect();
  const joined1 = await j1;
  // attach both roster waiters BEFORE c2 connects, so neither misses the broadcast
  const c1Roster = waitForRoster(c1, 2);
  const c2Roster = waitForRoster(c2, 2);
  const j2 = once(c2, 'joined');
  c2.connect();
  const joined2 = await j2;
  const roster = await c2Roster;
  await c1Roster;
  return { c1, c2, roster, id1: `${joined1.clientId}:player-1`, id2: `${joined2.clientId}:player-1` };
}

describe('relay ↔ NetClient', () => {
  it('client and server agree on protocol version', () => {
    expect(CLIENT_VERSION).toBe(SERVER_VERSION);
  });

  it('two clients join and both receive the full namespaced roster', async () => {
    const port = await startRelay();
    const { roster, id1, id2 } = await joinTwo(port);
    expect(roster.roster.map((p: any) => p.id).sort()).toEqual([id1, id2].sort());
    expect(roster.roster.every((p: any) => p.ownerId)).toBe(true);
  });

  it('broadcasts a shot to everyone including the sender', async () => {
    const port = await startRelay();
    const { c1, c2, id1 } = await joinTwo(port);
    const onC1 = once(c1, 'shot');
    const onC2 = once(c2, 'shot');
    c1.sendShotResult(id1, { ballSpeed: 100 });
    const [s1, s2] = await Promise.all([onC1, onC2]);
    expect(s1.playerId).toBe(id1);
    expect(s2.result).toEqual({ ballSpeed: 100 });
  });

  it('broadcasts a live shot_launch to everyone including the sender', async () => {
    const port = await startRelay();
    const { c1, c2, id1 } = await joinTwo(port);
    const onC1 = once(c1, 'launch');
    const onC2 = once(c2, 'launch');
    const launch = { shot: { ballSpeed: 120 }, start: [0, 0, 0], aim: [0, 0, 100] } as any;
    c1.sendShotLaunch(id1, launch);
    const [l1, l2] = await Promise.all([onC1, onC2]);
    expect(l1.playerId).toBe(id1);
    expect(l2.launch).toEqual(launch);
  });

  it('drops a shot_launch for a player the sender does not own', async () => {
    const port = await startRelay();
    const { c1, c2, id2 } = await joinTwo(port);
    let c2GotLaunch = false;
    c2.on('launch', () => { c2GotLaunch = true; });
    c1.sendShotLaunch(id2, { shot: { ballSpeed: 1 }, start: [0, 0, 0], aim: [0, 0, 1] } as any);
    await new Promise((r) => setTimeout(r, 150));
    expect(c2GotLaunch).toBe(false);
  });

  it('start closes the lobby for everyone with the final roster', async () => {
    const port = await startRelay();
    const { c1, c2, id1, id2 } = await joinTwo(port);
    const s1 = once(c1, 'started');
    const s2 = once(c2, 'started');
    c2.sendStart(); // anyone in the room may start
    const [m1, m2] = await Promise.all([s1, s2]);
    expect(m1.roster.map((p: any) => p.id).sort()).toEqual([id1, id2].sort());
    expect(m2.roster).toEqual(m1.roster);
  });

  it('turns away a client that joins after the round has started', async () => {
    const port = await startRelay();
    const { c1 } = await joinTwo(port);
    const started = once(c1, 'started');
    c1.sendStart();
    await started;
    const late = makeClient(port, { roomCode: 'garage', courseUrl: 'course.glb', players: playersFor('C') });
    const err = once(late, 'error');
    late.connect();
    expect(await err).toMatch(/already started/i);
  });

  it('drops a shot_result for a player the sender does not own', async () => {
    const port = await startRelay();
    const { c1, c2, id2 } = await joinTwo(port);
    let c2GotShot = false;
    c2.on('shot', () => { c2GotShot = true; });
    c1.sendShotResult(id2, { ballSpeed: 999 }); // c1 doesn't own id2
    await new Promise((r) => setTimeout(r, 150));
    expect(c2GotShot).toBe(false);
  });

  it('a returning client reclaims its slot, player ids and missed shots', async () => {
    const port = await startRelay();
    const { c1, c2, id1, id2 } = await joinTwo(port);
    const key = c2.clientKey;

    const started = once(c1, 'started');
    c1.sendStart();
    await started;

    // c2 drops mid-round
    c2.close();
    await new Promise((r) => setTimeout(r, 100));

    // the round carries on without them
    c1.sendShotResult(id1, { endPosition: [0, 0, 30], isHoled: false } as any);
    await once(c1, 'shot');

    // ...and they come back with the same key, having seen no shots
    const back = makeClient(port, {
      roomCode: 'garage', courseUrl: 'course.glb', players: playersFor('B'), clientKey: key,
    });
    const rejoined = once(back, 'joined');
    const replayed = once(back, 'shot');
    back.connect();

    const joined = await rejoined;
    expect(joined.resumed).toBe(true);
    // same identity: the other client's game is built around these exact ids
    expect(joined.clientId).toBe(id2.split(':')[0]);
    expect(joined.room.roster.map((p: any) => p.id).sort()).toEqual([id1, id2].sort());

    // and the shot taken while they were away is replayed
    const missed = await replayed;
    expect(missed.playerId).toBe(id1);
    expect(missed.result.endPosition).toEqual([0, 0, 30]);
  });

  it('keeps a dropped player in the roster mid-round, but not in the lobby', async () => {
    const port = await startRelay();
    const { c1, c2 } = await joinTwo(port, 'lobbyroom');
    const shrunk = waitForRoster(c1, 1);
    c2.close();
    expect((await shrunk).roster).toHaveLength(1); // lobby: they're gone

    const { c1: d1, c2: d2 } = await joinTwo(port, 'playingroom');
    const started = once(d1, 'started');
    d1.sendStart();
    await started;
    const rosterAfterDrop = once(d1, 'roster');
    d2.close();
    // mid-round the roster is frozen — every client's game depends on it
    expect((await rosterAfterDrop).roster).toHaveLength(2);
  });

  it('updates the roster when a client leaves', async () => {
    const port = await startRelay();
    const { c1, c2 } = await joinTwo(port);
    const shrunk = waitForRoster(c1, 1);
    c2.leave();
    const roster = await shrunk;
    expect(roster.roster).toHaveLength(1);
  });

  it('rejects a join with the wrong room secret', async () => {
    const port = await startRelay({ secret: 'correct-horse' });
    const c = makeClient(port, { roomCode: 'g', roomSecret: 'wrong', courseUrl: 'x', players: playersFor('A') });
    const err = once(c, 'error');
    c.connect();
    expect(await err).toMatch(/secret/i);
  });

  it('rejects a join whose courseUrl does not match the room', async () => {
    const port = await startRelay();
    const c1 = makeClient(port, { roomCode: 'g', courseUrl: 'a.glb', players: playersFor('A') });
    const j1 = once(c1, 'joined');
    c1.connect();
    await j1;
    const c2 = makeClient(port, { roomCode: 'g', courseUrl: 'b.glb', players: playersFor('B') });
    const err = once(c2, 'error');
    c2.connect();
    expect(await err).toMatch(/course/i);
  });
});

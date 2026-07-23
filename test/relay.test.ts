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

  it('advances the turn on hole_complete', async () => {
    const port = await startRelay();
    const { c1, c2, id1, id2 } = await joinTwo(port);
    const onTurn = once(c2, 'turn');
    c1.sendHoleComplete(id1, '1', 3); // id1 done with hole 1 -> id2 is up
    const turn = await onTurn;
    expect(turn.holeNumber).toBe('1');
    expect(turn.playerId).toBe(id2);
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

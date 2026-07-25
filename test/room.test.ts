import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain JS server module, no types
import { Room } from '../server/room.js';

/** Minimal fake socket that records what was broadcast to it. */
function fakeSocket() {
  return { readyState: 1, sent: [] as any[], send(raw: string) { this.sent.push(JSON.parse(raw)); } };
}
const players = (...ids: string[]) => ids.map((id) => ({ name: id, id, clubs: [] }));

describe('Room — roster & id namespacing', () => {
  it('namespaces player ids by client so identical ids never collide', () => {
    const room = new Room('garage', 'course.glb');
    room.addClient('c1', fakeSocket(), players('player-1'));
    room.addClient('c2', fakeSocket(), players('player-1')); // same original id!

    expect(room.roster.map((p: any) => p.id)).toEqual(['c1:player-1', 'c2:player-1']);
    expect(room.roster.every((p: any) => p.ownerId)).toBe(true);
  });

  it('ownsPlayer reflects the namespaced ids', () => {
    const room = new Room('g');
    room.addClient('c1', fakeSocket(), players('a', 'b'));
    expect(room.ownsPlayer('c1', 'c1:a')).toBe(true);
    expect(room.ownsPlayer('c1', 'c1:x')).toBe(false);
    expect(room.ownsPlayer('c2', 'c1:a')).toBe(false);
  });

  it('removeClient drops that client\'s players from the roster', () => {
    const room = new Room('g');
    room.addClient('c1', fakeSocket(), players('a'));
    room.addClient('c2', fakeSocket(), players('b'));
    room.removeClient('c1');
    expect(room.roster.map((p: any) => p.id)).toEqual(['c2:b']);
  });
});

describe('Room — lobby state', () => {
  it('reports started in the roster message and the snapshot', () => {
    const room = new Room('g', 'course.glb');
    room.addClient('c1', fakeSocket(), players('a'));
    expect(room.rosterMessage().started).toBe(false);
    room.started = true;
    expect(room.rosterMessage().started).toBe(true);
    expect(room.snapshot()).toMatchObject({ code: 'g', courseUrl: 'course.glb', started: true });
  });
});

describe('Room — broadcast', () => {
  it('sends a serialized message to every open client socket', () => {
    const room = new Room('g');
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    room.addClient('c1', s1, players('a'));
    room.addClient('c2', s2, players('b'));
    room.broadcast({ type: 'shot', playerId: 'c1:a', result: {} });
    expect(s1.sent.at(-1)).toEqual({ type: 'shot', playerId: 'c1:a', result: {} });
    expect(s2.sent.at(-1)).toEqual({ type: 'shot', playerId: 'c1:a', result: {} });
  });
});

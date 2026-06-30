// Unit tests for the authoritative simulation. The World is pure and
// deterministic — it takes an injected Rng and clock — so we can drive it tick by
// tick and assert exact outcomes without any networking or AWS. Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesetFor, TICK_RATE, WORLD_WIDTH, WORLD_HEIGHT } from '@game/shared';
import { World } from '../src/sim/world.js';
import { Rng } from '../src/sim/rng.js';

const DT = 1 / TICK_RATE;

/** A World with a controllable clock starting at t=0. */
function makeWorld(mode: 'coop' | 'ffa' | 'lastStanding', seed = 1) {
  let clock = 0;
  const world = new World(rulesetFor(mode), new Rng(seed), () => clock);
  return {
    world,
    advance(ms: number) {
      clock += ms;
    },
    tick(n = 1) {
      for (let i = 0; i < n; i++) world.step(DT);
    },
  };
}

test('starts in lobby; sim does not run until host starts', () => {
  const { world, tick } = makeWorld('coop');
  world.addPlayer('host', 'Host');
  let snap = world.snapshot();
  assert.equal(snap.phase, 'lobby');
  assert.equal(snap.asteroids.length, 0, 'no asteroids before start');

  // Ticking in lobby must not spawn anything or move the world into play.
  tick(10);
  snap = world.snapshot();
  assert.equal(snap.phase, 'lobby');
  assert.equal(snap.asteroids.length, 0);

  world.start();
  snap = world.snapshot();
  assert.equal(snap.phase, 'playing');
  assert.ok(snap.asteroids.length > 0, 'wave spawns on start');
});

test('start() is idempotent and ignored once playing', () => {
  const { world } = makeWorld('coop');
  world.addPlayer('host', 'Host');
  world.start();
  const wave1 = world.snapshot().wave;
  world.start(); // second call should be a no-op
  assert.equal(world.snapshot().wave, wave1);
});

test('ship thrust accelerates and screen-wraps toroidally', () => {
  const { world, tick } = makeWorld('coop');
  world.addPlayer('host', 'Host');
  world.start();

  const start = world.snapshot().ships.find((s) => s.playerId === 'host')!;
  assert.ok(start, 'host ship exists');

  // Hold thrust for ~1s; velocity must grow from rest.
  world.setInput('host', { seq: 1, thrust: true, rotate: 0, fire: false });
  tick(TICK_RATE);
  const moved = world.snapshot().ships.find((s) => s.playerId === 'host')!;
  const speed = Math.hypot(moved.vel.x, moved.vel.y);
  assert.ok(speed > 0, 'thrust produces velocity');

  // Position always stays within the toroidal world bounds.
  assert.ok(moved.pos.x >= 0 && moved.pos.x < WORLD_WIDTH);
  assert.ok(moved.pos.y >= 0 && moved.pos.y < WORLD_HEIGHT);
});

test('stale/duplicate input frames are ignored (seq must increase)', () => {
  const { world, tick } = makeWorld('coop');
  world.addPlayer('host', 'Host');
  world.start();
  world.setInput('host', { seq: 5, thrust: true, rotate: 0, fire: false });
  tick(2);
  // A lower seq must not override the active input.
  world.setInput('host', { seq: 3, thrust: false, rotate: 0, fire: false });
  tick(2);
  const ship = world.snapshot().ships.find((s) => s.playerId === 'host')!;
  assert.ok(Math.hypot(ship.vel.x, ship.vel.y) > 0, 'stale frame did not stop the ship');
});

test('co-op disables friendly fire: a ship is unharmed by another player bullet', () => {
  const { world, tick, advance } = makeWorld('coop');
  world.addPlayer('host', 'Host');
  world.addPlayer('guest', 'Guest');
  world.start();

  // Let spawn invulnerability lapse, then fire continuously between players.
  advance(5000);
  world.setInput('host', { seq: 1, thrust: false, rotate: 0, fire: true });
  world.setInput('guest', { seq: 1, thrust: false, rotate: 0, fire: true });
  tick(TICK_RATE * 3);

  const ships = world.snapshot().ships;
  // In co-op nobody should have lost a life to friendly fire.
  for (const s of ships) assert.equal(s.lives, rulesetFor('coop').lives, `${s.name} kept all lives`);
});

test('scoreboard reports every connected player', () => {
  const { world } = makeWorld('ffa');
  world.addPlayer('host', 'Host');
  world.addPlayer('g1', 'Ana');
  world.addPlayer('g2', 'Bo');
  world.start();
  const ids = world.snapshot().scoreboard.map((e) => e.playerId).sort();
  assert.deepEqual(ids, ['g1', 'g2', 'host']);
});

test('playerCount tracks connect/disconnect', () => {
  const { world } = makeWorld('ffa');
  assert.equal(world.playerCount(), 0);
  world.addPlayer('host', 'Host');
  world.addPlayer('g1', 'Ana');
  assert.equal(world.playerCount(), 2);
  world.removePlayer('g1');
  assert.equal(world.playerCount(), 1);
});

test('reconnect (refresh) preserves score and re-spawns a live ship', () => {
  const { world } = makeWorld('ffa');
  world.addPlayer('g1', 'Ana');
  world.start();
  // Give the player a score, then snapshot it.
  const ship = world.snapshot().ships.find((s) => s.playerId === 'g1')!;
  ship.score = 42;
  const before = world.snapshot().scoreboard.find((e) => e.playerId === 'g1')!;
  assert.equal(before.score, 42);

  // Disconnect (close tab) then reconnect with the SAME id (refresh).
  world.removePlayer('g1');
  assert.equal(world.playerCount(), 0);
  world.addPlayer('g1', 'Ana');

  assert.equal(world.playerCount(), 1, 'counted as connected again');
  const after = world.snapshot();
  const entry = after.scoreboard.find((e) => e.playerId === 'g1')!;
  assert.equal(entry.score, 42, 'score survived the reconnect');
  const reship = after.ships.find((s) => s.playerId === 'g1');
  assert.ok(reship?.alive, 're-spawned a live ship to rejoin the round');
});

test('last-standing: round ends with a winner when one ship remains', () => {
  const { world, tick, advance } = makeWorld('lastStanding');
  world.addPlayer('host', 'Host');
  world.addPlayer('guest', 'Guest');
  world.start();
  assert.equal(world.snapshot().phase, 'playing');

  // Guest leaves; with only the host left, the round should resolve.
  world.removePlayer('guest');
  advance(100);
  tick(2);
  const snap = world.snapshot();
  assert.equal(snap.phase, 'roundOver');
  assert.equal(snap.winnerName, 'Host');
});

test('snapshot is JSON-serializable (wire-safe)', () => {
  const { world } = makeWorld('coop');
  world.addPlayer('host', 'Host');
  world.start();
  const snap = world.snapshot();
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)));
});

import {
  ASTEROID_RADII,
  ASTEROID_SPEED,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Asteroid,
  type AsteroidSize,
  type Vec2,
} from '@game/shared';
import { Rng, newId } from './rng.js';

/** Children produced when an asteroid is destroyed. */
const SPLIT: Record<AsteroidSize, AsteroidSize | null> = { L: 'M', M: 'S', S: null };

export function makeAsteroid(rng: Rng, size: AsteroidSize, pos: Vec2): Asteroid {
  const speed = ASTEROID_SPEED[size] * rng.range(0.6, 1.2);
  const dir = rng.range(0, Math.PI * 2);
  return {
    id: newId(),
    pos: { x: pos.x, y: pos.y },
    vel: { x: Math.cos(dir) * speed, y: Math.sin(dir) * speed },
    size,
    angle: rng.range(0, Math.PI * 2),
    spin: rng.range(-1.5, 1.5),
  };
}

/** Spawn `count` large asteroids at the screen edges (away from center). */
export function spawnWave(rng: Rng, count: number): Asteroid[] {
  const out: Asteroid[] = [];
  for (let i = 0; i < count; i++) {
    const onVerticalEdge = rng.next() < 0.5;
    const pos: Vec2 = onVerticalEdge
      ? { x: rng.next() < 0.5 ? 0 : WORLD_WIDTH, y: rng.range(0, WORLD_HEIGHT) }
      : { x: rng.range(0, WORLD_WIDTH), y: rng.next() < 0.5 ? 0 : WORLD_HEIGHT };
    out.push(makeAsteroid(rng, 'L', pos));
  }
  return out;
}

/** Split an asteroid into its children (empty if it was the smallest size). */
export function splitAsteroid(rng: Rng, a: Asteroid): Asteroid[] {
  const childSize = SPLIT[a.size];
  if (!childSize) return [];
  return [makeAsteroid(rng, childSize, a.pos), makeAsteroid(rng, childSize, a.pos)];
}

export function asteroidRadius(size: AsteroidSize): number {
  return ASTEROID_RADII[size];
}

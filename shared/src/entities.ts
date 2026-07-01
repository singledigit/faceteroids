// Core game entity shapes. These are the authoritative server types and are also
// what the client renders from snapshots, so they must stay serialization-friendly
// (plain data, no methods, no class instances on the wire).

import type { GameMode } from './modes.js';

export interface Vec2 {
  x: number;
  y: number;
}

/** Toroidal world dimensions (screen wraps on both axes). */
export const WORLD_WIDTH = 1280;
export const WORLD_HEIGHT = 720;

export type AsteroidSize = 'L' | 'M' | 'S';

export interface Ship {
  id: string;
  /** Stable player identity (host marker or guestId). */
  playerId: string;
  name: string;
  pos: Vec2;
  vel: Vec2;
  /** Facing angle in radians. */
  angle: number;
  thrusting: boolean;
  alive: boolean;
  lives: number;
  score: number;
  /** Server time (ms) until which the ship cannot be damaged. */
  spawnInvulnUntil: number;
}

export interface Bullet {
  id: string;
  ownerId: string;
  pos: Vec2;
  vel: Vec2;
  /** Server time (ms) at which the bullet despawns. */
  expiresAt: number;
}

export interface Asteroid {
  id: string;
  pos: Vec2;
  vel: Vec2;
  size: AsteroidSize;
  /** Visual rotation, radians. */
  angle: number;
  spin: number;
}

export type GamePhase = 'lobby' | 'playing' | 'roundOver';

export interface ScoreEntry {
  playerId: string;
  name: string;
  score: number;
  alive: boolean;
  lives: number;
}

/** Authoritative world state broadcast to clients. */
export interface Snapshot {
  tick: number;
  serverTimeMs: number;
  mode: GameMode;
  phase: GamePhase;
  wave: number;
  ships: Ship[];
  bullets: Bullet[];
  asteroids: Asteroid[];
  scoreboard: ScoreEntry[];
  /** Set when phase === 'roundOver'. */
  winnerName?: string;
}

// --- Tunable simulation constants (shared so client dead-reckoning matches) ---
export const TICK_RATE = 30; // authoritative sim ticks per second
export const SNAPSHOT_EVERY_N_TICKS = 2; // broadcast at 15 Hz
export const SHIP_THRUST = 320; // px/s^2
export const SHIP_TURN_RATE = 4.2; // rad/s
export const SHIP_MAX_SPEED = 480; // px/s
export const SHIP_FRICTION = 0.6; // velocity retained per second (drag)
export const SHIP_RADIUS = 14;
export const BULLET_SPEED = 620; // px/s
export const BULLET_TTL_MS = 1100;
export const BULLET_RADIUS = 2;
export const FIRE_COOLDOWN_MS = 220;
export const ASTEROID_RADII: Record<AsteroidSize, number> = { L: 48, M: 26, S: 14 };
export const ASTEROID_SPEED: Record<AsteroidSize, number> = { L: 60, M: 90, S: 130 };
export const ASTEROID_SCORE: Record<AsteroidSize, number> = { L: 20, M: 50, S: 100 };
export const SHIP_KILL_SCORE = 150;
export const RESPAWN_DELAY_MS = 2000;

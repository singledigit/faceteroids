// Authoritative game world: entity store, physics integration, collision
// resolution, and per-mode rules. Pure simulation — no networking here.

import {
  ASTEROID_SCORE,
  BULLET_RADIUS,
  BULLET_SPEED,
  BULLET_TTL_MS,
  FIRE_COOLDOWN_MS,
  RESPAWN_DELAY_MS,
  SHIP_FRICTION,
  SHIP_KILL_SCORE,
  SHIP_MAX_SPEED,
  SHIP_RADIUS,
  SHIP_THRUST,
  SHIP_TURN_RATE,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Asteroid,
  type Bullet,
  type GameEventKind,
  type GamePhase,
  type Ruleset,
  type ScoreEntry,
  type Ship,
  type Snapshot,
  type Vec2,
} from '@game/shared';
import { Rng, newId } from './rng.js';
import { asteroidRadius, spawnWave, splitAsteroid } from './spawn.js';

export interface PlayerInput {
  seq: number;
  thrust: boolean;
  rotate: -1 | 0 | 1;
  fire: boolean;
}

interface Player {
  id: string;
  name: string;
  ship: Ship | null;
  input: PlayerInput;
  lastProcessedSeq: number;
  lastFireAt: number;
  respawnAt: number | null;
  connected: boolean;
}

export interface SimEvent {
  kind: GameEventKind;
  data?: Record<string, unknown>;
}

function wrap(p: Vec2): void {
  if (p.x < 0) p.x += WORLD_WIDTH;
  else if (p.x >= WORLD_WIDTH) p.x -= WORLD_WIDTH;
  if (p.y < 0) p.y += WORLD_HEIGHT;
  else if (p.y >= WORLD_HEIGHT) p.y -= WORLD_HEIGHT;
}

/** Shortest toroidal distance squared between two points. */
function wrappedDist2(a: Vec2, b: Vec2): number {
  let dx = Math.abs(a.x - b.x);
  let dy = Math.abs(a.y - b.y);
  if (dx > WORLD_WIDTH / 2) dx = WORLD_WIDTH - dx;
  if (dy > WORLD_HEIGHT / 2) dy = WORLD_HEIGHT - dy;
  return dx * dx + dy * dy;
}

export class World {
  private readonly players = new Map<string, Player>();
  private bullets: Bullet[] = [];
  private asteroids: Asteroid[] = [];
  private tick = 0;
  private phase: GamePhase = 'lobby';
  private wave = 0;
  private winnerName: string | undefined;
  private events: SimEvent[] = [];

  constructor(
    private readonly ruleset: Ruleset,
    private readonly rng: Rng,
    private readonly now: () => number,
  ) {}

  /** Re-seed the RNG (called from the /resume hook). */
  reseed(seed: number): void {
    this.rng.reseed(seed);
  }

  addPlayer(id: string, name: string): void {
    let p = this.players.get(id);
    if (p) {
      // Reconnect (e.g. browser refresh): keep score/lives, mark connected.
      p.connected = true;
      p.name = name;
      // Disconnect left the ship dead. If the round is live and the player still
      // has lives, give them a fresh ship (preserving score/lives via spawnShip)
      // so they rejoin the action. Permanently-eliminated players stay out.
      const lives = p.ship?.lives ?? this.ruleset.lives;
      if (this.phase === 'playing' && !p.ship?.alive && (this.ruleset.respawn || lives > 0)) {
        this.spawnShip(p);
      }
      return;
    }
    p = {
      id,
      name,
      ship: null,
      input: { seq: 0, thrust: false, rotate: 0, fire: false },
      lastProcessedSeq: 0,
      lastFireAt: 0,
      respawnAt: null,
      connected: true,
    };
    this.players.set(id, p);
    this.spawnShip(p);
    // No auto-start: players gather in the lobby/waiting room until the host
    // sends a 'start'. Ships exist but the sim only integrates in 'playing'.
  }

  /** Host-triggered: begin the round from the lobby. No-op once playing. */
  start(): void {
    if (this.phase !== 'lobby') return;
    // Re-spawn everyone fresh so positions/invuln are set at the true start.
    for (const p of this.players.values()) {
      if (p.connected) this.spawnShip(p);
    }
    this.startRound();
  }

  removePlayer(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    // Keep the (now-dead) ship so a reconnect can restore score/lives; just take
    // it out of play. Nulling it would lose the player's progress on refresh.
    if (p.ship) p.ship.alive = false;
    // In last-standing, a disconnect counts as elimination; re-check the round.
    if (this.ruleset.lastAliveWins) this.checkLastStanding();
  }

  setInput(id: string, input: PlayerInput): void {
    const p = this.players.get(id);
    if (!p) return;
    // Ignore stale/out-of-order frames.
    if (input.seq <= p.input.seq) return;
    p.input = input;
  }

  playerCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  private startRound(): void {
    this.phase = 'playing';
    this.wave = 0;
    this.winnerName = undefined;
    this.bullets = [];
    this.asteroids = [];
    this.nextWave();
  }

  private nextWave(): void {
    this.wave++;
    const count = this.ruleset.waves ? 3 + this.wave : 5;
    this.asteroids.push(...spawnWave(this.rng, count));
    this.events.push({ kind: 'wave', data: { wave: this.wave } });
  }

  private spawnShip(p: Player): void {
    const invuln = this.now() + this.ruleset.spawnInvulnSeconds * 1000;
    p.ship = {
      id: newId(),
      playerId: p.id,
      name: p.name,
      pos: { x: WORLD_WIDTH / 2 + this.rng.range(-120, 120), y: WORLD_HEIGHT / 2 + this.rng.range(-120, 120) },
      vel: { x: 0, y: 0 },
      angle: this.rng.range(0, Math.PI * 2),
      thrusting: false,
      alive: true,
      lives: p.ship?.lives ?? this.ruleset.lives,
      score: p.ship?.score ?? 0,
      spawnInvulnUntil: invuln,
    };
    p.respawnAt = null;
  }

  /** Advance the simulation by one fixed step `dt` (seconds). */
  step(dt: number): void {
    this.tick++;
    const now = this.now();

    if (this.phase === 'playing') {
      this.integrateShips(dt, now);
      this.integrateBullets(dt, now);
      this.integrateAsteroids(dt);
      this.handleCollisions(now);
      this.handleRespawns(now);
      this.checkWaveCleared();
    }
  }

  private integrateShips(dt: number, now: number): void {
    for (const p of this.players.values()) {
      const s = p.ship;
      if (!s || !s.alive) continue;
      const inp = p.input;
      p.lastProcessedSeq = inp.seq;

      s.angle += inp.rotate * SHIP_TURN_RATE * dt;
      s.thrusting = inp.thrust;
      if (inp.thrust) {
        s.vel.x += Math.cos(s.angle) * SHIP_THRUST * dt;
        s.vel.y += Math.sin(s.angle) * SHIP_THRUST * dt;
      }
      // Exponential drag.
      const drag = Math.pow(SHIP_FRICTION, dt);
      s.vel.x *= drag;
      s.vel.y *= drag;
      const speed = Math.hypot(s.vel.x, s.vel.y);
      if (speed > SHIP_MAX_SPEED) {
        s.vel.x = (s.vel.x / speed) * SHIP_MAX_SPEED;
        s.vel.y = (s.vel.y / speed) * SHIP_MAX_SPEED;
      }
      s.pos.x += s.vel.x * dt;
      s.pos.y += s.vel.y * dt;
      wrap(s.pos);

      if (inp.fire && now - p.lastFireAt >= FIRE_COOLDOWN_MS) {
        p.lastFireAt = now;
        this.bullets.push({
          id: newId(),
          ownerId: p.id,
          pos: { x: s.pos.x + Math.cos(s.angle) * SHIP_RADIUS, y: s.pos.y + Math.sin(s.angle) * SHIP_RADIUS },
          vel: { x: Math.cos(s.angle) * BULLET_SPEED + s.vel.x, y: Math.sin(s.angle) * BULLET_SPEED + s.vel.y },
          expiresAt: now + BULLET_TTL_MS,
        });
      }
    }
  }

  private integrateBullets(dt: number, now: number): void {
    const alive: Bullet[] = [];
    for (const b of this.bullets) {
      if (b.expiresAt <= now) continue;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      wrap(b.pos);
      alive.push(b);
    }
    this.bullets = alive;
  }

  private integrateAsteroids(dt: number): void {
    for (const a of this.asteroids) {
      a.pos.x += a.vel.x * dt;
      a.pos.y += a.vel.y * dt;
      a.angle += a.spin * dt;
      wrap(a.pos);
    }
  }

  private handleCollisions(now: number): void {
    // Bullet <-> asteroid.
    const survivingBullets: Bullet[] = [];
    for (const b of this.bullets) {
      let hit = false;
      for (let i = 0; i < this.asteroids.length; i++) {
        const a = this.asteroids[i]!;
        const r = asteroidRadius(a.size) + BULLET_RADIUS;
        if (wrappedDist2(b.pos, a.pos) <= r * r) {
          hit = true;
          this.destroyAsteroid(i, b.ownerId);
          break;
        }
      }
      if (!hit) survivingBullets.push(b);
    }
    this.bullets = survivingBullets;

    // Ship <-> asteroid, and (friendly fire) bullet/ship <-> ship.
    for (const p of this.players.values()) {
      const s = p.ship;
      if (!s || !s.alive || now < s.spawnInvulnUntil) continue;

      for (const a of this.asteroids) {
        const r = asteroidRadius(a.size) + SHIP_RADIUS;
        if (wrappedDist2(s.pos, a.pos) <= r * r) {
          this.killShip(p, undefined, now);
          break;
        }
      }
      if (!s.alive) continue;

      if (this.ruleset.friendlyFire) {
        // Bullets from other players.
        for (let i = 0; i < this.bullets.length; i++) {
          const b = this.bullets[i]!;
          if (b.ownerId === p.id) continue;
          const r = SHIP_RADIUS + BULLET_RADIUS;
          if (wrappedDist2(s.pos, b.pos) <= r * r) {
            this.bullets.splice(i, 1);
            this.killShip(p, b.ownerId, now);
            break;
          }
        }
      }
    }
  }

  private destroyAsteroid(index: number, byPlayerId: string): void {
    const a = this.asteroids[index]!;
    this.asteroids.splice(index, 1);
    this.asteroids.push(...splitAsteroid(this.rng, a));
    const shooter = this.players.get(byPlayerId);
    if (shooter?.ship) shooter.ship.score += ASTEROID_SCORE[a.size];
  }

  private killShip(p: Player, byPlayerId: string | undefined, now: number): void {
    const s = p.ship;
    if (!s) return;
    s.alive = false;
    s.lives -= 1;
    this.events.push({ kind: 'death', data: { playerId: p.id, by: byPlayerId } });
    if (byPlayerId && byPlayerId !== p.id) {
      const killer = this.players.get(byPlayerId);
      if (killer?.ship) {
        killer.ship.score += SHIP_KILL_SCORE;
        this.events.push({ kind: 'kill', data: { playerId: byPlayerId, victim: p.id } });
      }
    }

    if (this.ruleset.respawn && s.lives > 0) {
      p.respawnAt = now + RESPAWN_DELAY_MS;
    } else {
      p.ship = { ...s }; // freeze final state; ship stays dead
      if (this.ruleset.lastAliveWins) this.checkLastStanding();
    }
  }

  private handleRespawns(now: number): void {
    for (const p of this.players.values()) {
      if (p.respawnAt !== null && now >= p.respawnAt && p.connected) {
        const lives = p.ship?.lives ?? this.ruleset.lives;
        const score = p.ship?.score ?? 0;
        this.spawnShip(p);
        if (p.ship) {
          p.ship.lives = lives;
          p.ship.score = score;
        }
        this.events.push({ kind: 'respawn', data: { playerId: p.id } });
      }
    }
  }

  private checkWaveCleared(): void {
    if (this.asteroids.length === 0 && this.phase === 'playing') {
      if (this.ruleset.waves) {
        this.nextWave();
      } else if (!this.ruleset.lastAliveWins) {
        // FFA / endless: keep rocks flowing.
        this.nextWave();
      }
    }
  }

  private checkLastStanding(): void {
    if (!this.ruleset.lastAliveWins || this.phase !== 'playing') return;
    const contenders = [...this.players.values()].filter(
      (p) => p.connected && p.ship && (p.ship.alive || p.ship.lives > 0),
    );
    if (contenders.length <= 1 && this.players.size > 1) {
      this.phase = 'roundOver';
      this.winnerName = contenders[0]?.name ?? 'No one';
      this.events.push({ kind: 'roundOver', data: { winnerName: this.winnerName } });
    }
  }

  /** Build a serializable snapshot of current world state. */
  snapshot(): Snapshot {
    const ships: Ship[] = [];
    const scoreboard: ScoreEntry[] = [];
    for (const p of this.players.values()) {
      if (p.ship) ships.push(p.ship);
      scoreboard.push({
        playerId: p.id,
        name: p.name,
        score: p.ship?.score ?? 0,
        alive: p.ship?.alive ?? false,
        lives: p.ship?.lives ?? 0,
      });
    }
    scoreboard.sort((a, b) => b.score - a.score);
    return {
      tick: this.tick,
      serverTimeMs: this.now(),
      mode: this.ruleset.mode,
      phase: this.phase,
      wave: this.wave,
      ships,
      bullets: this.bullets,
      asteroids: this.asteroids,
      scoreboard,
      winnerName: this.winnerName,
    };
  }

  ackSeqFor(playerId: string): number {
    return this.players.get(playerId)?.lastProcessedSeq ?? 0;
  }

  /** Drain queued one-shot events for broadcast. */
  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

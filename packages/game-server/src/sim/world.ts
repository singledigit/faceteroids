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
  /** Server time (ms) the player disconnected, or null if connected. */
  disconnectedAt: number | null;
}

/**
 * Grace window after a disconnect. Within it, the player's ship is hidden and
 * neutral (can't be hit, can't act) but its full state is preserved, so a browser
 * refresh resumes the SAME ship at the SAME position. Only past this window does
 * the disconnect count as a real death/elimination.
 */
const DISCONNECT_GRACE_MS = 10_000;
/** Brief invulnerability granted on resume so you can't die on the frame you return. */
const RESUME_INVULN_MS = 1500;

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
  /** Wall-clock (ms) of the most recent step — used to detect the suspend gap. */
  private lastStepAt = 0;

  constructor(
    private readonly ruleset: Ruleset,
    private readonly rng: Rng,
    private readonly now: () => number,
  ) {}

  /** Re-seed the RNG (called from the /resume hook). */
  reseed(seed: number): void {
    this.rng.reseed(seed);
  }

  /**
   * Called on /resume. The game clock is Date.now(), which is frozen while the VM
   * is suspended and then jumps forward by the whole pause duration on resume.
   * Every stored ABSOLUTE timestamp (fire cooldown, spawn-invuln, disconnect
   * grace, bullet TTL) would otherwise instantly look "long past" — causing the
   * ship to fire on its own (stale cooldown), the disconnect grace to falsely
   * expire (respawn + invuln blink), etc. Shift them all forward by the gap so
   * the time-RELATIVE deltas are preserved exactly as before the pause.
   */
  onResume(): void {
    if (this.lastStepAt === 0) return;
    const gap = this.now() - this.lastStepAt;
    if (gap <= 0) return;
    for (const p of this.players.values()) {
      p.lastFireAt += gap;
      if (p.respawnAt !== null) p.respawnAt += gap;
      if (p.disconnectedAt !== null) p.disconnectedAt += gap;
      if (p.ship) {
        p.ship.spawnInvulnUntil += gap;
        p.ship.thrusting = false;
      }
      // Drop any held input frozen in the snapshot (e.g. fire/thrust that was
      // down when paused) so the ship doesn't act on its own until the client
      // sends fresh frames after reconnecting.
      p.input = { seq: p.input.seq, thrust: false, rotate: 0, fire: false };
    }
    for (const b of this.bullets) b.expiresAt += gap;
    this.lastStepAt = this.now();
  }

  addPlayer(id: string, name: string): void {
    let p = this.players.get(id);
    if (p) {
      // Reconnect (e.g. browser refresh).
      const wasGraced = p.disconnectedAt !== null;
      p.connected = true;
      p.disconnectedAt = null;
      p.name = name;
      // The fresh client restarts its input sequence at 0. Reset the server's
      // high-water mark so those frames aren't rejected as stale — otherwise the
      // player can't steer until seq climbs back past the pre-refresh value,
      // which at 60Hz can take many seconds (the "respawned but frozen" bug).
      p.input = { seq: 0, thrust: false, rotate: 0, fire: false };
      p.lastProcessedSeq = 0;

      if (this.phase === 'playing' && p.ship?.alive) {
        // Resumed within the grace window: same ship, same spot. Grant a brief
        // invuln so you can't be killed on the frame you return.
        if (wasGraced) p.ship.spawnInvulnUntil = this.now() + RESUME_INVULN_MS;
      } else if (this.phase === 'playing' && !p.ship?.alive) {
        // Came back after the ship had truly died — respawn if lives remain.
        const lives = p.ship?.lives ?? this.ruleset.lives;
        if (this.ruleset.respawn || lives > 0) this.spawnShip(p);
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
      disconnectedAt: null,
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
    p.disconnectedAt = this.now();
    // Don't kill the ship yet — keep it intact during the grace window so a quick
    // refresh resumes the same ship. It's neutralized in the step loop (no input,
    // can't collide) and only converted to a real death if the window elapses.
    // Note: last-standing elimination is deferred to expiry, so a refresh doesn't
    // instantly hand the win to someone else.
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
    this.lastStepAt = now;

    if (this.phase === 'playing') {
      this.expireDisconnects(now);
      this.integrateShips(dt, now);
      this.integrateBullets(dt, now);
      this.integrateAsteroids(dt);
      this.handleCollisions(now);
      this.handleRespawns(now);
      this.checkWaveCleared();
    }
  }

  /** Convert disconnects that outlast the grace window into real deaths. */
  private expireDisconnects(now: number): void {
    for (const p of this.players.values()) {
      if (p.disconnectedAt === null) continue;
      if (now - p.disconnectedAt < DISCONNECT_GRACE_MS) continue;
      // Grace elapsed: the player isn't coming back. Kill the ship for good and,
      // in last-standing, re-check whether the round is now decided.
      p.disconnectedAt = null;
      if (p.ship) p.ship.alive = false;
      if (this.ruleset.lastAliveWins) this.checkLastStanding();
    }
  }

  private integrateShips(dt: number, now: number): void {
    for (const p of this.players.values()) {
      const s = p.ship;
      if (!s || !s.alive) continue;
      // Ship is in the disconnect grace window: freeze it in place (no input,
      // no drift, no firing) until the owner returns or the window expires.
      if (p.disconnectedAt !== null) {
        s.thrusting = false;
        continue;
      }
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
      // Skip dead ships, spawn-invulnerable ships, and ships whose owner is in the
      // disconnect grace window (frozen and untouchable until they return).
      if (!s || !s.alive || p.disconnectedAt !== null || now < s.spawnInvulnUntil) continue;

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
    // A player inside the disconnect grace window still counts as a contender —
    // a refresh must not instantly hand someone else the win. Their elimination
    // (if they don't return) is re-checked when the grace window expires.
    const contenders = [...this.players.values()].filter(
      (p) =>
        (p.connected || p.disconnectedAt !== null) &&
        p.ship &&
        (p.ship.alive || p.ship.lives > 0),
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

// Canvas renderer: a neon-vector take on Asteroids. Draws a twinkling starfield,
// deterministically-jagged cratered asteroids with rim light, sleek fighter ships
// with glowing engine flames + shield rings, glowing bullet tracers, and a modern
// HUD. Pure rendering from snapshots — no game state lives here.

import {
  ASTEROID_RADII,
  SHIP_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Asteroid,
  type Snapshot,
} from '@game/shared';

// Vivid neon palette assigned per player (by scoreboard order).
const SHIP_COLORS = [
  '#5eead4', // teal
  '#facc15', // amber
  '#f472b6', // pink
  '#818cf8', // indigo
  '#4ade80', // green
  '#fb923c', // orange
  '#38bdf8', // sky
  '#c084fc', // violet
];

interface Star {
  x: number;
  y: number;
  r: number;
  a: number; // base alpha
  tw: number; // twinkle speed
}

interface AsteroidShape {
  verts: number[]; // radius multiplier per vertex
  craters: { x: number; y: number; r: number }[];
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stars: Star[] = [];
  private readonly shapeCache = new Map<string, AsteroidShape>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly myPlayerId: () => string,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    canvas.width = WORLD_WIDTH;
    canvas.height = WORLD_HEIGHT;

    // Static starfield (deterministic enough; purely cosmetic).
    const rnd = mulberry32(0xa57e201d);
    const count = 160;
    for (let i = 0; i < count; i++) {
      this.stars.push({
        x: rnd() * WORLD_WIDTH,
        y: rnd() * WORLD_HEIGHT,
        r: rnd() * 1.3 + 0.2,
        a: rnd() * 0.5 + 0.15,
        tw: rnd() * 2 + 0.5,
      });
    }
  }

  /** Stable jagged silhouette + craters for an asteroid, seeded by its id. */
  private shapeFor(a: Asteroid): AsteroidShape {
    let s = this.shapeCache.get(a.id);
    if (s) return s;
    const rnd = mulberry32(hashStr(a.id));
    const points = a.size === 'L' ? 13 : a.size === 'M' ? 10 : 8;
    const verts: number[] = [];
    for (let i = 0; i < points; i++) verts.push(0.72 + rnd() * 0.42);
    const craterCount = a.size === 'L' ? 4 : a.size === 'M' ? 2 : 1;
    const craters: AsteroidShape['craters'] = [];
    for (let i = 0; i < craterCount; i++) {
      const ang = rnd() * Math.PI * 2;
      const dist = rnd() * 0.5;
      craters.push({ x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r: 0.1 + rnd() * 0.18 });
    }
    s = { verts, craters };
    // Bound memory across long sessions.
    if (this.shapeCache.size > 600) this.shapeCache.clear();
    this.shapeCache.set(a.id, s);
    return s;
  }

  render(snap: Snapshot): void {
    const ctx = this.ctx;
    const t = performance.now();

    this.drawBackground(t);

    for (const a of snap.asteroids) this.drawAsteroid(ctx, a);

    // Player colors by scoreboard order.
    const colorFor = new Map<string, string>();
    snap.scoreboard.forEach((e, i) => colorFor.set(e.playerId, SHIP_COLORS[i % SHIP_COLORS.length]!));

    for (const b of snap.bullets) {
      this.drawBullet(ctx, b, colorFor.get(b.ownerId) ?? '#ffffff');
    }

    const me = this.myPlayerId();
    for (const s of snap.ships) {
      if (!s.alive) continue;
      this.drawShip(ctx, s, colorFor.get(s.playerId) ?? '#5eead4', s.playerId === me, snap.serverTimeMs, t);
    }

    this.drawOverlay(snap);
  }

  // ---- Background ----
  private drawBackground(t: number): void {
    const ctx = this.ctx;
    // Deep space gradient.
    const g = ctx.createRadialGradient(
      WORLD_WIDTH / 2, WORLD_HEIGHT / 2, 80,
      WORLD_WIDTH / 2, WORLD_HEIGHT / 2, WORLD_WIDTH * 0.7,
    );
    g.addColorStop(0, '#0c1020');
    g.addColorStop(1, '#05060d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // Twinkling stars.
    for (const st of this.stars) {
      const tw = 0.6 + 0.4 * Math.sin(t * 0.001 * st.tw + st.x);
      ctx.globalAlpha = st.a * tw;
      ctx.fillStyle = '#cfe3ff';
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ---- Asteroids ----
  private drawAsteroid(ctx: CanvasRenderingContext2D, a: Asteroid): void {
    const r = ASTEROID_RADII[a.size];
    const shape = this.shapeFor(a);
    ctx.save();
    ctx.translate(a.pos.x, a.pos.y);
    ctx.rotate(a.angle);

    // Rocky body with a subtle radial shade.
    ctx.beginPath();
    const n = shape.verts.length;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      const rad = r * shape.verts[i]!;
      const x = Math.cos(ang) * rad;
      const y = Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const fill = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
    fill.addColorStop(0, '#3a4358');
    fill.addColorStop(1, '#1a2030');
    ctx.fillStyle = fill;
    ctx.fill();

    // Rim light.
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(150,170,210,0.55)';
    ctx.stroke();

    // Craters.
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    for (const c of shape.craters) {
      ctx.beginPath();
      ctx.arc(c.x * r, c.y * r, c.r * r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- Bullets ----
  private drawBullet(ctx: CanvasRenderingContext2D, b: { pos: { x: number; y: number }; vel: { x: number; y: number } }, color: string): void {
    const sp = Math.hypot(b.vel.x, b.vel.y) || 1;
    const ux = b.vel.x / sp;
    const uy = b.vel.y / sp;
    const tail = 14;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Glowing streak.
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.pos.x - ux * tail, b.pos.y - uy * tail);
    ctx.lineTo(b.pos.x, b.pos.y);
    ctx.stroke();
    // Bright core.
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- Ships ----
  private drawShip(
    ctx: CanvasRenderingContext2D,
    s: Snapshot['ships'][number],
    color: string,
    isMe: boolean,
    serverTimeMs: number,
    t: number,
  ): void {
    const R = SHIP_RADIUS;
    const invuln = s.spawnInvulnUntil > serverTimeMs;

    ctx.save();
    ctx.translate(s.pos.x, s.pos.y);
    ctx.rotate(s.angle);

    // Engine flame (additive, flickering) — drawn first so the hull sits on top.
    if (s.thrusting) {
      const base = -R * 0.74; // tail of the (scaled) hull
      const flick = 0.75 + Math.random() * 0.5;
      const len = R * (2.0 + 0.6 * Math.sin(t * 0.05)) * flick;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.shadowColor = 'rgba(255,160,60,0.9)';
      ctx.shadowBlur = 16;
      const fg = ctx.createLinearGradient(base, 0, base - len, 0);
      fg.addColorStop(0, 'rgba(255,245,200,0.95)');
      fg.addColorStop(0.35, 'rgba(255,150,60,0.75)');
      fg.addColorStop(1, 'rgba(255,80,30,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(base, R * 0.42);
      ctx.lineTo(base - len, 0);
      ctx.lineTo(base, -R * 0.42);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Spawn shield.
    if (invuln) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 0.012);
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.4 * pulse;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Hull: sleek fighter silhouette with a colored glow + glossy fill. Slightly
    // larger than the collision radius so ships read clearly against big rocks.
    const SC = 1.35;
    const nose = R * 1.5 * SC;
    const wing = R * 0.95 * SC;
    const tail = R * 0.55 * SC;
    // Outer glow pass (additive) so the ship pops on the dark field.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = color;
    ctx.shadowBlur = isMe ? 22 : 14;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(nose, 0);
    ctx.lineTo(-wing, wing * 0.85);
    ctx.lineTo(-tail, 0);
    ctx.lineTo(-wing, -wing * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Solid hull on top.
    ctx.beginPath();
    ctx.moveTo(nose, 0);
    ctx.lineTo(-wing, wing * 0.85);
    ctx.lineTo(-tail, 0);
    ctx.lineTo(-wing, -wing * 0.85);
    ctx.closePath();
    const hull = ctx.createLinearGradient(nose, 0, -wing, 0);
    hull.addColorStop(0, '#ffffff');
    hull.addColorStop(0.25, color);
    hull.addColorStop(1, 'rgba(10,14,24,0.95)');
    ctx.fillStyle = hull;
    ctx.fill();
    ctx.lineWidth = isMe ? 2.5 : 1.8;
    ctx.strokeStyle = isMe ? '#ffffff' : color;
    ctx.stroke();

    // Cockpit dot.
    ctx.fillStyle = isMe ? '#ffffff' : 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(R * 0.4, 0, R * 0.2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Name tag.
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = isMe ? '#ffffff' : color;
    ctx.font = '600 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(s.name, s.pos.x, s.pos.y - R - 12);
    ctx.globalAlpha = 1;
  }

  // ---- HUD ----
  private drawOverlay(snap: Snapshot): void {
    const ctx = this.ctx;

    // Mode / wave chip (top-left).
    const chip = `${snap.mode.toUpperCase()}  ·  WAVE ${snap.wave}`;
    ctx.font = '600 13px Inter, system-ui, sans-serif';
    const cw = ctx.measureText(chip).width + 24;
    this.roundRect(16, 16, cw, 30, 8);
    ctx.fillStyle = 'rgba(12,16,28,0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(94,234,212,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#5eead4';
    ctx.textAlign = 'left';
    ctx.fillText(chip, 28, 36);

    // Scoreboard panel (top-right).
    const rows = snap.scoreboard.slice(0, 8);
    const panelW = 210;
    const panelH = 18 + rows.length * 22;
    const px = WORLD_WIDTH - panelW - 16;
    this.roundRect(px, 16, panelW, panelH, 10);
    ctx.fillStyle = 'rgba(12,16,28,0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();

    let y = 38;
    ctx.font = '600 13px Inter, system-ui, sans-serif';
    rows.forEach((e, i) => {
      const color = SHIP_COLORS[i % SHIP_COLORS.length]!;
      ctx.fillStyle = color;
      ctx.fillRect(px + 14, y - 9, 6, 10);
      ctx.fillStyle = e.alive ? '#e6e9f5' : '#6b7280';
      ctx.textAlign = 'left';
      ctx.fillText(e.name.slice(0, 14), px + 28, y);
      ctx.textAlign = 'right';
      const lives = Number.isFinite(e.lives) ? ' ' + '●'.repeat(Math.max(0, e.lives)) : '';
      ctx.fillStyle = e.alive ? '#9aa0b4' : '#5b6070';
      ctx.fillText(`${e.score}${lives}`, px + panelW - 14, y);
      y += 22;
    });

    if (snap.phase === 'roundOver') {
      ctx.fillStyle = 'rgba(5,6,13,0.72)';
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#5eead4';
      ctx.shadowColor = '#5eead4';
      ctx.shadowBlur = 24;
      ctx.font = '800 52px Inter, system-ui, sans-serif';
      ctx.fillText(`${snap.winnerName ?? 'Nobody'} wins`, WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#8a90a6';
      ctx.font = '500 16px Inter, system-ui, sans-serif';
      ctx.fillText('Round over', WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 36);
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

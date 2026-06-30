// Vector-style canvas renderer. Draws the toroidal world, ships, bullets, and
// asteroids, plus a scoreboard/phase overlay. Pure rendering from snapshots.

import {
  ASTEROID_RADII,
  SHIP_RADIUS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Snapshot,
} from '@game/shared';

const SHIP_COLORS = ['#5ad', '#fa5', '#5f8', '#f58', '#af5', '#85f', '#ff5', '#f55'];

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly myPlayerId: () => string,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    canvas.width = WORLD_WIDTH;
    canvas.height = WORLD_HEIGHT;
  }

  render(snap: Snapshot): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    // Asteroids.
    ctx.strokeStyle = '#9a9';
    ctx.lineWidth = 2;
    for (const a of snap.asteroids) {
      const r = ASTEROID_RADII[a.size];
      ctx.save();
      ctx.translate(a.pos.x, a.pos.y);
      ctx.rotate(a.angle);
      ctx.beginPath();
      const points = a.size === 'L' ? 10 : a.size === 'M' ? 8 : 6;
      for (let i = 0; i < points; i++) {
        const ang = (i / points) * Math.PI * 2;
        const jag = i % 2 === 0 ? r : r * 0.78;
        const x = Math.cos(ang) * jag;
        const y = Math.sin(ang) * jag;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    // Bullets.
    ctx.fillStyle = '#fff';
    for (const b of snap.bullets) {
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Ships.
    const me = this.myPlayerId();
    let colorIdx = 0;
    const colorFor = new Map<string, string>();
    for (const e of snap.scoreboard) {
      colorFor.set(e.playerId, SHIP_COLORS[colorIdx % SHIP_COLORS.length]!);
      colorIdx++;
    }
    const now = performance.now();
    for (const s of snap.ships) {
      if (!s.alive) continue;
      const color = colorFor.get(s.playerId) ?? '#5ad';
      const invuln = s.spawnInvulnUntil > snap.serverTimeMs;
      ctx.save();
      ctx.translate(s.pos.x, s.pos.y);
      ctx.rotate(s.angle);
      ctx.globalAlpha = invuln && Math.floor(now / 120) % 2 === 0 ? 0.4 : 1;
      ctx.strokeStyle = s.playerId === me ? '#fff' : color;
      ctx.lineWidth = s.playerId === me ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(SHIP_RADIUS, 0);
      ctx.lineTo(-SHIP_RADIUS * 0.7, SHIP_RADIUS * 0.7);
      ctx.lineTo(-SHIP_RADIUS * 0.4, 0);
      ctx.lineTo(-SHIP_RADIUS * 0.7, -SHIP_RADIUS * 0.7);
      ctx.closePath();
      ctx.stroke();
      if (s.thrusting) {
        ctx.strokeStyle = '#fa3';
        ctx.beginPath();
        ctx.moveTo(-SHIP_RADIUS * 0.5, 0);
        ctx.lineTo(-SHIP_RADIUS * 1.2, 0);
        ctx.stroke();
      }
      ctx.restore();

      // Name tag.
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(s.name, s.pos.x, s.pos.y - SHIP_RADIUS - 8);
    }
    ctx.globalAlpha = 1;

    this.drawOverlay(snap);
  }

  private drawOverlay(snap: Snapshot): void {
    const ctx = this.ctx;
    ctx.textAlign = 'left';
    ctx.font = '14px monospace';
    ctx.fillStyle = '#cce';
    let y = 24;
    ctx.fillText(`MODE ${snap.mode.toUpperCase()}   WAVE ${snap.wave}`, 16, y);
    y += 22;
    for (const e of snap.scoreboard) {
      ctx.fillStyle = e.alive ? '#cce' : '#778';
      const lives = Number.isFinite(e.lives) ? `♥${e.lives}` : '';
      ctx.fillText(`${e.name}  ${e.score}  ${lives}`, 16, y);
      y += 18;
    }

    if (snap.phase === 'roundOver') {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, WORLD_HEIGHT / 2 - 60, WORLD_WIDTH, 120);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.font = '40px monospace';
      ctx.fillText(`${snap.winnerName ?? 'Nobody'} wins!`, WORLD_WIDTH / 2, WORLD_HEIGHT / 2 + 14);
    }
  }
}

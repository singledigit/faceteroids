// Snapshot interpolation buffer. We render ~100 ms in the past and lerp entity
// positions between the two bracketing snapshots, smoothing out the 15 Hz
// broadcast into fluid motion. Toroidal wrap is handled by lerping along the
// shortest path and re-wrapping.

import { WORLD_HEIGHT, WORLD_WIDTH, type Snapshot, type Vec2 } from '@game/shared';

const INTERP_DELAY_MS = 100;
const BUFFER_MAX = 20;

interface Timed {
  recvAt: number;
  snap: Snapshot;
}

export class SnapshotBuffer {
  private buf: Timed[] = [];

  push(snap: Snapshot, now: number): void {
    this.buf.push({ recvAt: now, snap });
    if (this.buf.length > BUFFER_MAX) this.buf.shift();
  }

  /** Latest snapshot (for scoreboard/phase — no interpolation needed). */
  latest(): Snapshot | null {
    return this.buf.length ? this.buf[this.buf.length - 1]!.snap : null;
  }

  /** Interpolated render state at `now - INTERP_DELAY_MS`. */
  sample(now: number): Snapshot | null {
    if (this.buf.length === 0) return null;
    if (this.buf.length === 1) return this.buf[0]!.snap;

    const renderTime = now - INTERP_DELAY_MS;
    let a: Timed | null = null;
    let b: Timed | null = null;
    for (let i = 0; i < this.buf.length - 1; i++) {
      if (this.buf[i]!.recvAt <= renderTime && this.buf[i + 1]!.recvAt >= renderTime) {
        a = this.buf[i]!;
        b = this.buf[i + 1]!;
        break;
      }
    }
    if (!a || !b) return this.buf[this.buf.length - 1]!.snap;

    const span = b.recvAt - a.recvAt || 1;
    const alpha = Math.min(1, Math.max(0, (renderTime - a.recvAt) / span));
    return lerpSnapshot(a.snap, b.snap, alpha);
  }
}

function lerpScalarWrapped(a: number, b: number, alpha: number, size: number): number {
  let d = b - a;
  if (d > size / 2) d -= size;
  else if (d < -size / 2) d += size;
  let v = a + d * alpha;
  if (v < 0) v += size;
  else if (v >= size) v -= size;
  return v;
}

function lerpPos(a: Vec2, b: Vec2, alpha: number): Vec2 {
  return {
    x: lerpScalarWrapped(a.x, b.x, alpha, WORLD_WIDTH),
    y: lerpScalarWrapped(a.y, b.y, alpha, WORLD_HEIGHT),
  };
}

function lerpAngle(a: number, b: number, alpha: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * alpha;
}

function lerpSnapshot(a: Snapshot, b: Snapshot, alpha: number): Snapshot {
  const byId = <T extends { id: string }>(arr: T[]) => new Map(arr.map((e) => [e.id, e]));
  const shipsA = byId(a.ships);
  const ships = b.ships.map((sb) => {
    const sa = shipsA.get(sb.id);
    if (!sa) return sb;
    return { ...sb, pos: lerpPos(sa.pos, sb.pos, alpha), angle: lerpAngle(sa.angle, sb.angle, alpha) };
  });
  const astA = byId(a.asteroids);
  const asteroids = b.asteroids.map((ab) => {
    const aa = astA.get(ab.id);
    if (!aa) return ab;
    return { ...ab, pos: lerpPos(aa.pos, ab.pos, alpha), angle: lerpAngle(aa.angle, ab.angle, alpha) };
  });
  // Bullets are fast and short-lived; render from b directly (no interpolation).
  return { ...b, ships, asteroids };
}

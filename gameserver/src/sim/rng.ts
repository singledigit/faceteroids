// Deterministic-per-instance RNG seeded from a CSPRNG. We never use Math.random:
// all MicroVMs boot from the SAME memory snapshot, so any randomness captured at
// build time would be identical across rooms. The seed is drawn from
// crypto.randomBytes inside the /run (and /resume) hook, guaranteeing each room
// gets a unique asteroid field even though they share a snapshot.

import { randomBytes, randomUUID } from 'node:crypto';

export class Rng {
  private state: number;

  constructor(seed: number) {
    // Avoid a zero state (mulberry32 degenerates).
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Draw a fresh CSPRNG seed. Call this from /run and /resume. */
  static freshSeed(): number {
    return randomBytes(4).readUInt32LE(0);
  }

  /** mulberry32 — fast, good enough for gameplay variety. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  reseed(seed: number): void {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
}

/** Entity IDs use a CSPRNG directly (uniqueness across rooms matters). */
export function newId(): string {
  return randomUUID();
}

// Fixed-timestep authoritative loop. Decouples the sim rate (TICK_RATE) from the
// snapshot broadcast rate (every SNAPSHOT_EVERY_N_TICKS ticks) using an
// accumulator, so the simulation is deterministic regardless of timer jitter.

import { SNAPSHOT_EVERY_N_TICKS, TICK_RATE } from '@game/shared';
import type { SimEvent, World } from './world.js';

export interface LoopHandlers {
  onSnapshot: () => void;
  onEvents: (events: SimEvent[]) => void;
}

export class GameLoop {
  private timer: NodeJS.Timeout | null = null;
  private accumulator = 0;
  private lastMs = 0;
  private tickCount = 0;
  private readonly dt = 1 / TICK_RATE;
  private readonly stepMs = 1000 / TICK_RATE;

  constructor(
    private readonly world: World,
    private readonly handlers: LoopHandlers,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastMs = this.now();
    // Run the driver a bit faster than the tick rate; the accumulator keeps the
    // actual simulation stepping at exactly TICK_RATE.
    this.timer = setInterval(() => this.drive(), this.stepMs / 2);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private drive(): void {
    const now = this.now();
    let frame = now - this.lastMs;
    this.lastMs = now;
    // Guard against huge catch-up loops after a suspend/resume gap.
    if (frame > 250) frame = this.stepMs;
    this.accumulator += frame;

    let stepped = false;
    while (this.accumulator >= this.stepMs) {
      this.world.step(this.dt);
      this.accumulator -= this.stepMs;
      this.tickCount++;
      stepped = true;
      if (this.tickCount % SNAPSHOT_EVERY_N_TICKS === 0) {
        this.handlers.onSnapshot();
      }
    }
    if (stepped) {
      const events = this.world.drainEvents();
      if (events.length) this.handlers.onEvents(events);
    }
  }
}

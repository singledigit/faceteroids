// Samples keyboard state into input frames at a fixed rate and sends them to the
// server. Inputs are intents (thrust/rotate/fire), never positions — the server
// is authoritative.

import type { WsClient } from '../net/wsClient.js';

export class InputSampler {
  private readonly keys = new Set<string>();
  private seq = 0;
  private timer: number | null = null;
  private client: WsClient | null = null;

  /** Attach to a (re)connected client and begin sampling. Idempotent. */
  start(client: WsClient): void {
    this.stop(); // never double-register listeners or intervals
    this.client = client;
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    // Sample at 60 Hz; the server only applies the latest frame per tick.
    this.timer = window.setInterval(() => this.sample(), 1000 / 60);
  }

  stop(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.client = null;
  }

  private onDown = (e: KeyboardEvent) => {
    if (this.tracked(e.code)) {
      this.keys.add(e.code);
      e.preventDefault();
    }
  };

  private onUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };

  private tracked(code: string): boolean {
    return (
      code === 'ArrowUp' ||
      code === 'ArrowLeft' ||
      code === 'ArrowRight' ||
      code === 'Space' ||
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyD'
    );
  }

  private sample(): void {
    const thrust = this.keys.has('ArrowUp') || this.keys.has('KeyW');
    const left = this.keys.has('ArrowLeft') || this.keys.has('KeyA');
    const right = this.keys.has('ArrowRight') || this.keys.has('KeyD');
    const fire = this.keys.has('Space');
    const rotate: -1 | 0 | 1 = left && !right ? -1 : right && !left ? 1 : 0;
    this.client?.send({ t: 'input', seq: ++this.seq, thrust, rotate, fire });
  }
}

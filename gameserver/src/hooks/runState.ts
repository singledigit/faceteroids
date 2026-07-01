// Per-MicroVM unique state, populated by the /run lifecycle hook (NOT at build
// time — all VMs share the same boot snapshot). Until /run delivers the room's
// mode + seed, the gameplay server has no room identity. In local/dev runs we
// fall back to env vars so the server is usable without the hook layer.

import { isGameMode, type GameMode } from '@game/shared';
import { Rng } from '../sim/rng.js';

export interface RunState {
  roomId: string;
  mode: GameMode;
  seed: number;
  /** Secret that proves host authority on the WS connection (from the control plane). */
  hostSecret?: string;
}

let current: RunState | null = null;

export function setRunState(state: RunState): void {
  current = state;
}

export function getRunState(): RunState | null {
  return current;
}

/** Resolve run state from env (local dev) when no /run hook has fired. */
export function runStateFromEnv(): RunState {
  const envMode = process.env.GAME_MODE;
  const mode: GameMode = isGameMode(envMode) ? envMode : 'coop';
  return {
    roomId: process.env.ROOM_ID ?? 'local-dev',
    mode,
    seed: Rng.freshSeed(),
  };
}

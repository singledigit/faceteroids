// WebSocket wire protocol between browser clients and the authoritative game
// server. Versioned so client/server mismatches can be detected and rejected.

import type { GameMode, Ruleset } from './modes.js';
import type { Snapshot } from './entities.js';

export const PROTOCOL_VERSION = 1;

// --- Client -> Server ---

/** Sent once immediately after the socket opens, to claim a player identity. */
export interface HelloMessage {
  t: 'hello';
  v: number;
  /** Stable identity: 'host' for the room owner, or the guestId for guests. */
  playerId: string;
  name: string;
  /**
   * Per-room secret proving host authority. Only the room creator receives it
   * (via the control plane); presenting it grants host-only powers like starting
   * the round. Guests never have it, so they can't claim host by sending
   * playerId:'host'.
   */
  hostSecret?: string;
}

/** Per-frame input intent. The server is authoritative; these are intents only. */
export interface InputMessage {
  t: 'input';
  /** Monotonic client sequence number (lets the server ignore stale frames). */
  seq: number;
  thrust: boolean;
  /** -1 = turn left, 0 = none, 1 = turn right. */
  rotate: -1 | 0 | 1;
  fire: boolean;
}

/** Host-only: begin the round from the lobby/waiting room. */
export interface StartMessage {
  t: 'start';
}

export type ClientMessage = HelloMessage | InputMessage | StartMessage;

// --- Server -> Client ---

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  playerId: string;
  mode: GameMode;
  ruleset: Ruleset;
  tickRate: number;
}

export interface SnapshotMessage {
  t: 'snapshot';
  /** Echo of the player's last processed input seq, for reconciliation. */
  ackSeq: number;
  snapshot: Snapshot;
}

export type GameEventKind = 'death' | 'respawn' | 'roundOver' | 'wave' | 'kill';

export interface EventMessage {
  t: 'event';
  kind: GameEventKind;
  /** Free-form event payload (e.g. { playerId, by, wave, winnerName }). */
  data?: Record<string, unknown>;
}

export interface ByeMessage {
  t: 'bye';
  reason: string;
}

export type ServerMessage = WelcomeMessage | SnapshotMessage | EventMessage | ByeMessage;

// --- Helpers ---

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as ClientMessage;
    if (m && typeof m === 'object' && typeof (m as { t?: unknown }).t === 'string') return m;
    return null;
  } catch {
    return null;
  }
}

export function decodeServer(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw) as ServerMessage;
    if (m && typeof m === 'object' && typeof (m as { t?: unknown }).t === 'string') return m;
    return null;
  } catch {
    return null;
  }
}

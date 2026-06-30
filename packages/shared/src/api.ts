// REST DTOs for the control-plane HTTP API (browser <-> Lambda).

import type { GameMode } from './modes.js';

export interface LoginRequest {
  username: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  expiresAt: number;
}

export interface CreateRoomRequest {
  mode: GameMode;
}

/** Returned to the host on create, and (minus host-only fields) to guests on join. */
export interface RoomConnectionInfo {
  roomId: string;
  mode: GameMode;
  /** MicroVM proxy host, e.g. <id>.lambda-microvm.<region>.on.aws */
  endpoint: string;
  /** Short-lived auth token (<= 60 min) for the WS subprotocol. */
  wsToken: string;
  wsTokenExpiresAt: number;
}

export interface CreateRoomResponse extends RoomConnectionInfo {
  joinUrl: string;
  /** Per-room secret proving host authority on the gameplay WS (host only). */
  hostSecret: string;
}

export type RoomStatus =
  | 'STARTING'
  | 'RUNNING'
  | 'SUSPENDED'
  | 'CLOSED'
  | 'TERMINATED';

export interface RoomStatusResponse {
  roomId: string;
  mode: GameMode;
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
}

export interface JoinRoomRequest {
  displayName: string;
}
export interface JoinRoomResponse extends RoomConnectionInfo {
  guestId: string;
  displayName: string;
  /** Room-scoped JWT used to authorize this guest's refresh/status calls. */
  guestJwt: string;
}

export interface RefreshTokenResponse {
  wsToken: string;
  wsTokenExpiresAt: number;
}

export const MAX_PLAYERS_PER_ROOM = 8;
/** WS auth tokens last 60 min; refresh proactively before this margin. */
export const TOKEN_REFRESH_MARGIN_MS = 10 * 60 * 1000;

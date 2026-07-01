// Self-contained API contract for the control-plane Lambda. These shapes MUST
// stay in sync with the browser client's copy (frontend/src/net/api.ts). We
// deliberately do NOT import the workspace `shared` package here: a deployed
// Lambda should be a standalone artifact with only real, installable npm
// dependencies — not a reach into an unpublished sibling package.

export const GAME_MODES = ['coop', 'ffa', 'lastStanding'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && (GAME_MODES as readonly string[]).includes(value);
}

/** Max players per room (soft gate here; the game server enforces the hard cap). */
export const MAX_PLAYERS_PER_ROOM = 8;

export type RoomStatus = 'STARTING' | 'RUNNING' | 'SUSPENDED' | 'CLOSED' | 'TERMINATED';

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

interface RoomConnectionInfo {
  roomId: string;
  mode: GameMode;
  endpoint: string;
  wsToken: string;
  wsTokenExpiresAt: number;
}

export interface CreateRoomResponse extends RoomConnectionInfo {
  joinUrl: string;
  hostSecret: string;
}

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
  guestToken: string;
}

export interface RefreshTokenResponse {
  wsToken: string;
  wsTokenExpiresAt: number;
}

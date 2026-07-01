// REST client for the control plane. The API base URL is resolved at runtime:
// when hosted on CloudFront the client fetches /config.json (written by CDK at
// deploy time); for local dev it falls back to VITE_API_URL or same-origin. This
// lets one `cdk deploy` build the static client once and point it at the API
// without a rebuild when the API URL changes.

import type {
  CreateRoomResponse,
  GameMode,
  JoinRoomResponse,
  LoginResponse,
  RoomStatusResponse,
  RefreshTokenResponse,
} from '@game/shared';

let apiBasePromise: Promise<string> | null = null;

function resolveApiBase(): Promise<string> {
  if (apiBasePromise) return apiBasePromise;
  apiBasePromise = (async () => {
    const fromEnv = import.meta.env.VITE_API_URL;
    if (fromEnv) return fromEnv.replace(/\/$/, '');
    try {
      const res = await fetch('/config.json', { cache: 'no-store' });
      if (res.ok) {
        const cfg = (await res.json()) as { apiUrl?: string };
        if (cfg.apiUrl) return cfg.apiUrl.replace(/\/$/, '');
      }
    } catch {
      /* fall through to same-origin */
    }
    return '';
  })();
  return apiBasePromise;
}

async function req<T>(path: string, init?: RequestInit & { token?: string }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init?.token) headers.authorization = `Bearer ${init.token}`;
  const api = await resolveApiBase();
  const res = await fetch(`${api}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function login(username: string, password: string): Promise<LoginResponse> {
  return req('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
}

export function createRoom(token: string, mode: GameMode): Promise<CreateRoomResponse> {
  return req('/rooms', { method: 'POST', token, body: JSON.stringify({ mode }) });
}

export function getRoomStatus(roomId: string): Promise<RoomStatusResponse> {
  return req(`/rooms/${roomId}`, { method: 'GET' });
}

export function joinRoom(roomId: string, displayName: string): Promise<JoinRoomResponse> {
  return req(`/rooms/${roomId}/join`, { method: 'POST', body: JSON.stringify({ displayName }) });
}

/** Guest: refresh the gameplay WS token using the opaque guest session token. */
export function refreshGuestToken(roomId: string, guestToken: string): Promise<RefreshTokenResponse> {
  return req(`/tokens/${roomId}/refresh`, { method: 'POST', token: guestToken });
}

/** Host: refresh the gameplay WS token (Cognito-authorized at the edge). */
export function refreshHostToken(roomId: string, hostToken: string): Promise<RefreshTokenResponse> {
  return req(`/rooms/${roomId}/token`, { method: 'POST', token: hostToken });
}

export function closeRoom(roomId: string, token: string): Promise<void> {
  return req(`/rooms/${roomId}/close`, { method: 'POST', token });
}

export function suspendRoom(roomId: string, token: string): Promise<void> {
  return req(`/rooms/${roomId}/suspend`, { method: 'POST', token });
}

export function resumeRoom(roomId: string, token: string): Promise<void> {
  return req(`/rooms/${roomId}/resume`, { method: 'POST', token });
}

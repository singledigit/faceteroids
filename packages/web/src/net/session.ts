// Per-tab session persistence so a browser refresh returns the player to the same
// room with the same identity (host stays host; a guest keeps their guestId, so
// their ship/score survive). We use sessionStorage, not localStorage: it survives
// a refresh but is scoped to the tab, so opening a second tab is a second player
// rather than two tabs fighting over one identity.
//
// The short-lived MicroVM WS token is deliberately NOT stored — it's re-minted on
// resume via /tokens/{roomId}/refresh using the longer-lived auth JWT below.

import type { GameMode } from '@game/shared';

const KEY = 'asteroids.session.v1';

interface BaseSession {
  roomId: string;
  endpoint: string;
  mode: GameMode;
  name: string;
}

export interface HostSession extends BaseSession {
  kind: 'host';
  /** Cognito ID token (also used to refresh the WS token). */
  hostToken: string;
  /** Per-room secret proving host authority on the gameplay WS. */
  hostSecret: string;
}

export interface GuestSession extends BaseSession {
  kind: 'guest';
  guestId: string;
  /** Opaque room-scoped session token (used to refresh the WS token). */
  guestToken: string;
}

export type Session = HostSession | GuestSession;

export function saveSession(s: Session): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage disabled — resume simply won't be available */
  }
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

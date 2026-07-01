// Persistent host authentication. The Cognito ID token is kept in localStorage
// (NOT sessionStorage) so a host stays logged in across visits and tabs — no
// re-login every time. We store the expiry and treat the token as gone once it's
// within a small margin of expiring, so callers fall back to the login form
// instead of firing requests that would 401.

const KEY = 'asteroids.auth.v1';
const EXPIRY_MARGIN_MS = 60_000; // treat as expired 1 min early

interface StoredAuth {
  token: string;
  expiresAt: number; // epoch ms
  username: string;
}

export function saveAuth(token: string, expiresAt: number, username: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token, expiresAt, username } satisfies StoredAuth));
  } catch {
    /* storage disabled — host will just log in each visit */
  }
}

/** Returns the stored auth if still valid, else null (and clears expired). */
export function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as StoredAuth;
    if (!a.token || a.expiresAt - EXPIRY_MARGIN_MS <= Date.now()) {
      clearAuth();
      return null;
    }
    return a;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

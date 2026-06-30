// Proactively refresh the MicroVM auth token before it expires (platform max is
// 60 min). The live WS survives expiry — auth is checked at upgrade — but any
// reconnect needs a fresh token, so we always keep a non-expired one in hand.

import { TOKEN_REFRESH_MARGIN_MS, type RefreshTokenResponse } from '@game/shared';

/** Mints a fresh WS token. Host and guest pass different implementations. */
export type RefreshFn = () => Promise<RefreshTokenResponse>;

export class TokenRefresher {
  private timer: number | null = null;
  private readonly subscribers: Array<(wsToken: string) => void> = [];

  constructor(private readonly refreshFn: RefreshFn) {}

  /** Register a callback invoked with each freshly minted WS token. */
  onToken(fn: (wsToken: string) => void): void {
    this.subscribers.push(fn);
  }

  /** Schedule the next refresh based on the current token's expiry. */
  schedule(expiresAt: number): void {
    this.clear();
    const delay = Math.max(5000, expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS);
    this.timer = window.setTimeout(() => void this.refresh(), delay);
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.refreshFn();
      for (const fn of this.subscribers) fn(res.wsToken);
      this.schedule(res.wsTokenExpiresAt);
    } catch {
      // Retry sooner on failure.
      this.timer = window.setTimeout(() => void this.refresh(), 30000);
    }
  }

  clear(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
  }
}

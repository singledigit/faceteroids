// Proactively refresh the MicroVM auth token before it expires (platform max is
// 60 min). The live WS survives expiry — auth is checked at upgrade — but any
// reconnect needs a fresh token, so we always keep a non-expired one in hand.

import { TOKEN_REFRESH_MARGIN_MS } from '@game/shared';
import { refreshToken } from './api.js';

export class TokenRefresher {
  private timer: number | null = null;

  constructor(
    private readonly roomId: string,
    private readonly authJwt: string,
    private readonly onToken: (wsToken: string) => void,
  ) {}

  /** Schedule the next refresh based on the current token's expiry. */
  schedule(expiresAt: number): void {
    this.clear();
    const delay = Math.max(5000, expiresAt - Date.now() - TOKEN_REFRESH_MARGIN_MS);
    this.timer = window.setTimeout(() => void this.refresh(), delay);
  }

  private async refresh(): Promise<void> {
    try {
      const res = await refreshToken(this.roomId, this.authJwt);
      this.onToken(res.wsToken);
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

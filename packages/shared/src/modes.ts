// Game modes and their rule configuration. One server build supports all three;
// the host picks a mode at room-creation time and it is delivered to the MicroVM
// via the /run hook's runHookPayload.

export const GAME_MODES = ['coop', 'ffa', 'lastStanding'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && (GAME_MODES as readonly string[]).includes(value);
}

/** Parameters that vary the shared simulation per mode. */
export interface Ruleset {
  readonly mode: GameMode;
  /** Can player bullets/ships damage other players? */
  readonly friendlyFire: boolean;
  /** Do players respawn after dying? (false => permadeath this round) */
  readonly respawn: boolean;
  /** Lives per player. Infinity for endless respawn modes. */
  readonly lives: number;
  /** Seconds of spawn invulnerability after (re)spawning. */
  readonly spawnInvulnSeconds: number;
  /** Does clearing all asteroids advance to escalating waves (co-op survival)? */
  readonly waves: boolean;
  /** Round ends when only one ship remains alive. */
  readonly lastAliveWins: boolean;
}

export const RULESETS: Record<GameMode, Ruleset> = {
  coop: {
    mode: 'coop',
    friendlyFire: false,
    respawn: true,
    lives: 3,
    spawnInvulnSeconds: 3,
    waves: true,
    lastAliveWins: false,
  },
  ffa: {
    mode: 'ffa',
    friendlyFire: true,
    respawn: true,
    lives: Infinity,
    spawnInvulnSeconds: 3,
    waves: false,
    lastAliveWins: false,
  },
  lastStanding: {
    mode: 'lastStanding',
    friendlyFire: true,
    respawn: false,
    lives: 3,
    spawnInvulnSeconds: 2,
    waves: false,
    lastAliveWins: true,
  },
};

export function rulesetFor(mode: GameMode): Ruleset {
  return RULESETS[mode];
}

export const MODE_LABELS: Record<GameMode, string> = {
  coop: 'Co-op — Survive the waves together',
  ffa: 'Free-for-all — Deathmatch',
  lastStanding: 'Last ship standing',
};

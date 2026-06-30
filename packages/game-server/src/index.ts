// MicroVM entrypoint. Boots the gameplay WS server (:8080) and the lifecycle-hooks
// server (:9000). In production the /run hook applies run state (mode + seed); in
// local dev (HOOKS disabled) we apply env-based run state immediately so the
// server is playable without the hook layer.

import { GameServer } from './ws/server.js';
import { startHooksServer } from './hooks/server.js';
import { getRunState, runStateFromEnv } from './hooks/runState.js';

const GAME_PORT = Number(process.env.GAME_PORT ?? 8080);
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 9000);
// When false (local dev), there is no Lambda /run hook — seed from env instead.
const HOOKS_ENABLED = process.env.HOOKS_ENABLED !== 'false';

function main(): void {
  const server = new GameServer();
  server.listen(GAME_PORT);
  startHooksServer(HOOK_PORT, server);

  if (!HOOKS_ENABLED || process.env.GAME_MODE) {
    // Local dev convenience: start a room immediately from env.
    if (!getRunState()) server.applyRunState(runStateFromEnv());
  }

  const shutdown = () => {
    console.log('[game] shutting down');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();

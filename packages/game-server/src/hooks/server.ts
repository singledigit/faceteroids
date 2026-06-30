// MicroVM lifecycle-hooks HTTP server (port 9000). Lambda calls these over the
// guest network namespace, so we bind 0.0.0.0 and run on a separate listener from
// gameplay (so /suspend answers 200 even under sim load). Paths and the 200/503
// contract follow the Lambda MicroVMs runtime spec.
//
// Crucially, /run is where this VM first learns its room identity (mode + a fresh
// CSPRNG seed) — none of that exists at build/snapshot time, which is what keeps
// every room unique despite sharing one boot snapshot.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isGameMode } from '@game/shared';
import { Rng } from '../sim/rng.js';
import { setRunState, type RunState } from './runState.js';
import type { GameServer } from '../ws/server.js';

const BASE = '/aws/lambda-microvms/runtime/v1';

interface RunHookPayload {
  roomId?: string;
  mode?: string;
  hostSecret?: string;
}

// The platform delivers the body as an envelope; our RunMicrovm runHookPayload
// arrives as a JSON *string* under the `runHookPayload` key (not the raw body).
interface RunHookEnvelope {
  microvmId?: string;
  runHookPayload?: string;
}

export function startHooksServer(port: number, game: GameServer): void {
  const server = createServer((req, res) => handle(req, res, game));
  server.listen(port, '0.0.0.0', () => {
    console.log(`[hooks] listening on :${port}${BASE}/*`);
  });
}

function handle(req: IncomingMessage, res: ServerResponse, game: GameServer): void {
  if (req.method !== 'POST' || !req.url?.startsWith(BASE)) {
    res.writeHead(404).end();
    return;
  }
  const hook = req.url.slice(BASE.length);

  readBody(req)
    .then((body) => {
      switch (hook) {
        case '/ready':
          // 200 once listeners are up + engine constructed; 503 to retry.
          return game.isReady() ? ok(res) : busy(res);

        case '/validate':
          // Exercise hot paths so the platform can prefetch snapshot pages.
          game.validateMockTick();
          return ok(res);

        case '/run': {
          // Per-VM identity arrives here. Seed is a fresh CSPRNG draw (never baked).
          // The body is an envelope; our payload is a JSON string under runHookPayload.
          const envelope = parse<RunHookEnvelope>(body);
          const payload = envelope?.runHookPayload
            ? parse<RunHookPayload>(envelope.runHookPayload)
            : parse<RunHookPayload>(body); // fallback if delivered raw
          if (!payload?.mode || !isGameMode(payload.mode)) {
            // Log so a misconfigured runHookPayload is diagnosable rather than
            // silently defaulting to coop.
            console.warn(`[hooks] /run: missing/invalid mode in payload; defaulting to coop`);
          }
          const mode = isGameMode(payload?.mode) ? payload.mode : 'coop';
          const run: RunState = {
            roomId: payload?.roomId ?? 'unknown',
            mode,
            seed: Rng.freshSeed(),
            hostSecret: payload?.hostSecret,
          };
          setRunState(run);
          game.applyRunState(run);
          return ok(res);
        }

        case '/resume':
          // Rebase time-relative state across the suspend wall-clock jump and
          // re-seed so randomness diverges from the pre-suspend memory state.
          game.resumed();
          return ok(res);

        case '/suspend':
          // Gameplay state is ephemeral; nothing to drain. Answer immediately.
          return ok(res);

        case '/terminate':
          return ok(res);

        default:
          res.writeHead(404).end();
          return;
      }
    })
    .catch(() => {
      res.writeHead(500).end();
    });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parse<T>(body: string): T | null {
  try {
    return body ? (JSON.parse(body) as T) : null;
  } catch {
    return null;
  }
}

function ok(res: ServerResponse): void {
  res.writeHead(200).end();
}
function busy(res: ServerResponse): void {
  res.writeHead(503).end();
}

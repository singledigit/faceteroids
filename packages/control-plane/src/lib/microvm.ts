// AWS SDK wrappers for the MicroVM operations the control plane performs.

import {
  CreateMicrovmAuthTokenCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  ResumeMicrovmCommand,
  TerminateMicrovmCommand,
  LambdaMicrovms,
} from '@aws-sdk/client-lambda-microvms';
import type { GameMode } from '@game/shared';
import {
  EXECUTION_ROLE_ARN,
  GAME_PORT,
  MICROVM_IMAGE_ARN,
  REGION,
  ROOM_MAX_DURATION_SECONDS,
  WS_TOKEN_TTL_MINUTES,
} from './config.js';

const client = new LambdaMicrovms({ region: REGION });

export interface RunResult {
  microvmId: string;
  endpoint: string;
}

/** Start a room's MicroVM, passing room identity + host secret to the /run hook. */
export async function runRoomVm(
  roomId: string,
  mode: GameMode,
  hostSecret: string,
): Promise<RunResult> {
  const res = await client.send(
    new RunMicrovmCommand({
      imageIdentifier: MICROVM_IMAGE_ARN,
      executionRoleArn: EXECUTION_ROLE_ARN,
      idlePolicy: {
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 1800,
        autoResumeEnabled: true,
      },
      maximumDurationInSeconds: ROOM_MAX_DURATION_SECONDS,
      runHookPayload: JSON.stringify({ roomId, mode, hostSecret }),
    }),
  );
  if (!res.microvmId || !res.endpoint) {
    throw new Error('RunMicrovm returned no microvmId/endpoint');
  }
  return { microvmId: res.microvmId, endpoint: res.endpoint };
}

export interface TokenResult {
  wsToken: string;
  wsTokenExpiresAt: number;
}

/** Mint a gameplay auth token scoped to a single VM's gameplay port. */
export async function mintWsToken(microvmId: string): Promise<TokenResult> {
  const res = await client.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: WS_TOKEN_TTL_MINUTES,
      allowedPorts: [{ port: GAME_PORT }],
    }),
  );
  const wsToken = res.authToken?.['X-aws-proxy-auth'];
  if (!wsToken) throw new Error('auth token missing X-aws-proxy-auth');
  return {
    wsToken,
    wsTokenExpiresAt: Date.now() + WS_TOKEN_TTL_MINUTES * 60 * 1000,
  };
}

export async function terminateVm(microvmId: string): Promise<void> {
  await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
}

/** Pause: snapshot RAM+disk and stop billing for compute. State is preserved. */
export async function suspendVm(microvmId: string): Promise<void> {
  await client.send(new SuspendMicrovmCommand({ microvmIdentifier: microvmId }));
}

/** Resume a suspended VM from its snapshot (game state intact). */
export async function resumeVm(microvmId: string): Promise<void> {
  await client.send(new ResumeMicrovmCommand({ microvmIdentifier: microvmId }));
}

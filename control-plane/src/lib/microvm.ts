// AWS SDK wrappers for the MicroVM operations the control plane performs.

import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  ResumeMicrovmCommand,
  TerminateMicrovmCommand,
  LambdaMicrovms,
  type MicrovmState,
} from '@aws-sdk/client-lambda-microvms';
import type { GameMode } from './contract.js';
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

/**
 * The VM's actual lifecycle state. Suspend/resume race their in-between states
 * (SUSPENDING, auto-resume, idle-policy auto-terminate), so on any conflict or
 * failure the room's DynamoDB status must be reconciled against THIS — never
 * assumed from which call happened to fail.
 */
export async function getVmState(microvmId: string): Promise<MicrovmState> {
  const res = await client.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
  if (!res.state) throw new Error('GetMicrovm returned no state');
  return res.state;
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

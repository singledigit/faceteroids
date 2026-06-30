// Manual data-plane test: RunMicrovm against the ACTIVE image, then mint an auth
// token scoped to the gameplay port. Prints the endpoint + token + a ready-to-use
// WebSocket subprotocol array so a browser/script can connect directly to the VM.
//
// This is the same sequence the control-plane roomsCreate handler performs; here
// it's exposed as a CLI for end-to-end verification before the API exists.

import {
  CreateMicrovmAuthTokenCommand,
  RunMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { isGameMode, type GameMode } from '@game/shared';
import { microvms } from '../lib/aws.js';
import { ACCOUNT_ID, GAME_PORT, MICROVM_IMAGE_ARN } from '../config.js';

const IMAGE_ARN = MICROVM_IMAGE_ARN;
const EXECUTION_ROLE_ARN =
  process.env.EXECUTION_ROLE_ARN ??
  `arn:aws:iam::${ACCOUNT_ID}:role/AsteroidsMicroVmExecutionRole`;

export async function runRoom(modeArg?: string): Promise<void> {
  const mode: GameMode = isGameMode(modeArg) ? modeArg : 'coop';
  const roomId = `cli-${Date.now().toString(36)}`;

  console.log(`[run] RunMicrovm image=${IMAGE_ARN} mode=${mode} room=${roomId}…`);
  const run = await microvms.send(
    new RunMicrovmCommand({
      imageIdentifier: IMAGE_ARN,
      executionRoleArn: EXECUTION_ROLE_ARN,
      idlePolicy: {
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 1800,
        autoResumeEnabled: true,
      },
      maximumDurationInSeconds: 28800,
      runHookPayload: JSON.stringify({ roomId, mode, hostSecret: 'cli-host-secret' }),
    }),
  );
  console.log(`[run] microvmId=${run.microvmId} state=${run.state}`);
  console.log(`[run] endpoint=${run.endpoint}`);

  console.log('[run] minting auth token (60 min, port 8080)…');
  const token = await microvms.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: run.microvmId!,
      expirationInMinutes: 60,
      allowedPorts: [{ port: GAME_PORT }],
    }),
  );
  const wsToken = token.authToken?.['X-aws-proxy-auth'];

  console.log('\n=== Connect info ===');
  console.log(JSON.stringify(
    {
      microvmId: run.microvmId,
      endpoint: run.endpoint,
      mode,
      wsToken,
      hostSecret: 'cli-host-secret',
      wsUrl: `wss://${run.endpoint}/play`,
      subprotocols: [
        'lambda-microvms',
        `lambda-microvms.authentication.${wsToken}`,
        `lambda-microvms.port.${GAME_PORT}`,
      ],
    },
    null,
    2,
  ));
}

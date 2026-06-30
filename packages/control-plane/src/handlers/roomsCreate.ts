import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  MAX_PLAYERS_PER_ROOM,
  isGameMode,
  type CreateRoomRequest,
  type CreateRoomResponse,
} from '@game/shared';
import { badRequest, forbidden, hostIdentity, ok, parseBody } from '../lib/http.js';
import { putRoom } from '../lib/ddb.js';
import { mintWsToken, runRoomVm } from '../lib/microvm.js';
import { ROOM_MAX_DURATION_SECONDS, WEB_BASE_URL } from '../lib/config.js';

// Host creates a room: RunMicrovm against the prebuilt image, persist the Room,
// mint the host's first gameplay token, and return a shareable join URL. The VM
// boots asynchronously — status starts at STARTING and the client polls
// GET /rooms/{id} (or simply retries the WS connect) until it's reachable.
// Authenticated at the edge by the Cognito JWT authorizer.
export async function roomsCreate(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const host = hostIdentity(event);
  if (!host) return forbidden('host login required');

  const body = parseBody<CreateRoomRequest>(event);
  if (!body || !isGameMode(body.mode)) return badRequest('valid mode required');

  const roomId = randomUUID();
  // Host-authority secret: delivered to the VM via /run and returned only to the
  // host here. Presenting it on the gameplay WS proves host powers (start round).
  const hostSecret = randomUUID();
  const { microvmId, endpoint } = await runRoomVm(roomId, body.mode, hostSecret);
  const { wsToken, wsTokenExpiresAt } = await mintWsToken(microvmId);

  const nowSec = Math.floor(Date.now() / 1000);
  await putRoom({
    PK: `ROOM#${roomId}`,
    SK: 'META',
    roomId,
    microvmId,
    endpoint,
    mode: body.mode,
    host: host.sub,
    status: 'STARTING',
    playerCount: 0,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    createdAt: nowSec,
    lastSeenAt: nowSec,
    expiresAt: nowSec + ROOM_MAX_DURATION_SECONDS,
  });

  const res: CreateRoomResponse = {
    roomId,
    mode: body.mode,
    endpoint,
    wsToken,
    wsTokenExpiresAt,
    joinUrl: `${WEB_BASE_URL}/?room=${roomId}`,
    hostSecret,
  };
  return ok(res);
}

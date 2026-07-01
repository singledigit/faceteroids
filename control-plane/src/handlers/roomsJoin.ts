import { randomUUID, randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { JoinRoomRequest, JoinRoomResponse } from '../lib/contract.js';
import { badRequest, json, notFound, ok, parseBody, pathParam } from '../lib/http.js';
import { adjustPlayerCount, createGuestSession, getRoom } from '../lib/ddb.js';
import { mintWsToken } from '../lib/microvm.js';
import { GUEST_SESSION_TTL_SECONDS } from '../lib/config.js';

// Login-less guest join (intentionally unauthenticated — the share link IS the
// invite). We mint a gameplay token scoped to THIS room's VM + gameplay port,
// and create a server-side guest SESSION keyed by a random opaque token. That
// token authorizes the guest's later refresh/status calls — no signing secret,
// revocable, and TTL-reaped.
export async function roomsJoin(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return badRequest('roomId required');

  const body = parseBody<JoinRoomRequest>(event);
  const displayName = (body?.displayName ?? 'Player').slice(0, 24) || 'Player';

  const room = await getRoom(roomId);
  if (!room) return notFound('room not found');
  if (room.status === 'CLOSED' || room.status === 'TERMINATED') {
    return json(410, { error: 'room closed' });
  }
  // Soft capacity gate; the game server enforces the hard limit at WS hello.
  if (room.playerCount >= room.maxPlayers) return json(409, { error: 'room full' });

  const guestId = randomUUID();
  const guestToken = randomBytes(32).toString('base64url'); // 256-bit opaque token
  const { wsToken, wsTokenExpiresAt } = await mintWsToken(room.microvmId);
  await createGuestSession(guestToken, guestId, roomId, displayName, GUEST_SESSION_TTL_SECONDS);
  await adjustPlayerCount(roomId, 1);

  const res: JoinRoomResponse = {
    roomId,
    mode: room.mode,
    endpoint: room.endpoint,
    wsToken,
    wsTokenExpiresAt,
    guestId,
    displayName,
    guestToken,
  };
  return ok(res);
}

import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { JoinRoomRequest, JoinRoomResponse } from '@game/shared';
import { badRequest, json, notFound, ok, parseBody, pathParam } from '../lib/http.js';
import { adjustPlayerCount, getRoom } from '../lib/ddb.js';
import { mintWsToken } from '../lib/microvm.js';
import { signGuest } from '../lib/jwt.js';

// Login-less guest join. Anyone with the link can join an open room. We mint a
// gameplay token scoped to THIS room's VM + gameplay port only, and a room-scoped
// guest JWT used solely to authorize this guest's later refresh/status calls.
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
  const { wsToken, wsTokenExpiresAt } = await mintWsToken(room.microvmId);
  const guestJwt = await signGuest(guestId, roomId);
  await adjustPlayerCount(roomId, 1);

  const res: JoinRoomResponse = {
    roomId,
    mode: room.mode,
    endpoint: room.endpoint,
    wsToken,
    wsTokenExpiresAt,
    guestId,
    displayName,
    guestJwt,
  };
  return ok(res);
}

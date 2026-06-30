import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RefreshTokenResponse } from '@game/shared';
import { isGuest, isHost } from '@game/shared';
import { authClaims, badRequest, forbidden, notFound, ok, pathParam, unauthorized } from '../lib/http.js';
import { getRoom } from '../lib/ddb.js';
import { mintWsToken } from '../lib/microvm.js';

// Mint a fresh 60-min gameplay token for the caller's room. Cross-room isolation:
// a guest JWT carries roomId and MUST match the path; the microvmId is re-derived
// server-side from DynamoDB (never trusted from the client). A guest of room A
// therefore cannot mint a token for room B.
export async function tokensRefresh(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return badRequest('roomId required');

  const claims = await authClaims(event);
  if (!claims) return unauthorized();

  const room = await getRoom(roomId);
  if (!room) return notFound('room not found');

  // Guests are bound to the room in their JWT; hosts must own the room.
  if (isGuest(claims)) {
    if (claims.roomId !== roomId) return forbidden('token not valid for this room');
  } else if (isHost(claims)) {
    if (room.host !== claims.sub) return forbidden('not the room host');
  } else {
    return forbidden();
  }

  const { wsToken, wsTokenExpiresAt } = await mintWsToken(room.microvmId);
  const res: RefreshTokenResponse = { wsToken, wsTokenExpiresAt };
  return ok(res);
}

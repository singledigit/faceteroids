import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RefreshTokenResponse } from '../lib/contract.js';
import { badRequest, forbidden, guestSession, notFound, ok, pathParam, unauthorized } from '../lib/http.js';
import { getRoom } from '../lib/ddb.js';
import { mintWsToken } from '../lib/microvm.js';

// Mint a fresh 60-min gameplay token for the caller's room. This route is open at
// the edge (guests have no Cognito login) and authorized here by the guest's
// opaque session token. Cross-room isolation: the session's roomId MUST match the
// path, and the microvmId is re-derived from DynamoDB — never trusted from the
// client — so a guest of room A cannot mint a token for room B.
export async function tokensRefresh(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return badRequest('roomId required');

  const session = await guestSession(event);
  if (!session) return unauthorized();
  if (session.roomId !== roomId) return forbidden('token not valid for this room');

  const room = await getRoom(roomId);
  if (!room) return notFound('room not found');

  const { wsToken, wsTokenExpiresAt } = await mintWsToken(room.microvmId);
  const res: RefreshTokenResponse = { wsToken, wsTokenExpiresAt };
  return ok(res);
}

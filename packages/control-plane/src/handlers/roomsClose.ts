import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { isHost } from '@game/shared';
import { authClaims, badRequest, forbidden, notFound, ok, pathParam, unauthorized } from '../lib/http.js';
import { getRoom, setRoomStatus } from '../lib/ddb.js';
import { terminateVm } from '../lib/microvm.js';

// Host explicitly closes a room: terminate the VM immediately (cost stop) and
// mark the room CLOSED. Idempotent — terminating an already-gone VM is fine.
export async function roomsClose(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return badRequest('roomId required');

  const claims = await authClaims(event);
  if (!claims) return unauthorized();
  if (!isHost(claims)) return forbidden('host login required');

  const room = await getRoom(roomId);
  if (!room) return notFound('room not found');
  if (room.host !== claims.sub) return forbidden('not the room host');

  try {
    await terminateVm(room.microvmId);
  } catch {
    // Already terminated / not found — proceed to mark CLOSED.
  }
  await setRoomStatus(roomId, 'CLOSED');
  return ok({ roomId, status: 'CLOSED' });
}

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { badRequest, forbidden, hostIdentity, notFound, ok, pathParam } from '../lib/http.js';
import { getRoom, setRoomStatus } from '../lib/ddb.js';
import { terminateVm } from '../lib/microvm.js';

// Host explicitly closes a room: terminate the VM immediately (cost stop) and
// mark the room CLOSED. Idempotent — terminating an already-gone VM is fine.
// Authenticated at the edge by the Cognito JWT authorizer.
export async function roomsClose(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return badRequest('roomId required');

  const host = hostIdentity(event);
  if (!host) return forbidden('host login required');

  const room = await getRoom(roomId);
  if (!room) return notFound('room not found');
  if (room.host !== host.sub) return forbidden('not the room host');

  try {
    await terminateVm(room.microvmId);
  } catch {
    // Already terminated / not found — proceed to mark CLOSED.
  }
  await setRoomStatus(roomId, 'CLOSED');
  return ok({ roomId, status: 'CLOSED' });
}

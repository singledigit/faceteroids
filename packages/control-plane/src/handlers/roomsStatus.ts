import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RoomStatusResponse } from '@game/shared';
import { badRequest, notFound, ok, pathParam } from '../lib/http.js';
import { getRoom } from '../lib/ddb.js';

// Public room status — the host polls this after create to learn when the VM is
// reachable. No auth required (it leaks only coarse status + counts).
export async function roomsStatus(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return badRequest('roomId required');

  const room = await getRoom(roomId);
  if (!room) return notFound('room not found');

  const res: RoomStatusResponse = {
    roomId: room.roomId,
    mode: room.mode,
    status: room.status,
    playerCount: room.playerCount,
    maxPlayers: room.maxPlayers,
  };
  return ok(res);
}

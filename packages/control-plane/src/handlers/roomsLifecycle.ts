import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { isHost } from '@game/shared';
import {
  authClaims,
  badRequest,
  forbidden,
  json,
  notFound,
  ok,
  pathParam,
  unauthorized,
} from '../lib/http.js';
import { getRoom, setRoomStatus, type RoomItem } from '../lib/ddb.js';
import { resumeVm, suspendVm } from '../lib/microvm.js';

type HostRoom =
  | { ok: false; error: APIGatewayProxyResultV2 }
  | { ok: true; roomId: string; room: RoomItem };

// Resolve + authorize a host-owned room for a lifecycle action. Returns the room
// or an error response.
async function hostRoom(event: APIGatewayProxyEventV2): Promise<HostRoom> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return { ok: false, error: badRequest('roomId required') };
  const claims = await authClaims(event);
  if (!claims) return { ok: false, error: unauthorized() };
  if (!isHost(claims)) return { ok: false, error: forbidden('host login required') };
  const room = await getRoom(roomId);
  if (!room) return { ok: false, error: notFound('room not found') };
  if (room.host !== claims.sub) return { ok: false, error: forbidden('not the room host') };
  return { ok: true, roomId, room };
}

// Host pauses the room: suspend the VM (snapshots RAM+disk; game state is
// preserved) and mark the room SUSPENDED. Clients see the disconnect, check
// status, and wait rather than forcing an auto-resume by reconnecting.
export async function roomsSuspend(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const r = await hostRoom(event);
  if (!r.ok) return r.error;
  if (r.room.status === 'CLOSED' || r.room.status === 'TERMINATED') {
    return badRequest('room is not running');
  }
  try {
    await suspendVm(r.room.microvmId);
  } catch (err) {
    // The VM rejects suspend unless it's RUNNING (e.g. still booting). Surface a
    // clear 409 so the client can tell the host to try again in a moment.
    if (err instanceof Error && err.name === 'ConflictException') {
      return json(409, { error: 'room not ready to pause yet — try again shortly' });
    }
    throw err;
  }
  await setRoomStatus(r.roomId, 'SUSPENDED');
  return ok({ roomId: r.roomId, status: 'SUSPENDED' });
}

// Host resumes a paused room: resume the VM from its snapshot and mark RUNNING.
export async function roomsResume(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const r = await hostRoom(event);
  if (!r.ok) return r.error;
  if (r.room.status === 'CLOSED' || r.room.status === 'TERMINATED') {
    return badRequest('room is closed');
  }
  try {
    await resumeVm(r.room.microvmId);
  } catch {
    // Already running (e.g. auto-resumed) — fall through to mark RUNNING.
  }
  await setRoomStatus(r.roomId, 'RUNNING');
  return ok({ roomId: r.roomId, status: 'RUNNING' });
}

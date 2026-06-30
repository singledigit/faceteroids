import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RefreshTokenResponse } from '@game/shared';
import {
  badRequest,
  forbidden,
  hostIdentity,
  json,
  notFound,
  ok,
  pathParam,
} from '../lib/http.js';
import { getRoom, setRoomStatus, type RoomItem } from '../lib/ddb.js';
import { mintWsToken, resumeVm, suspendVm } from '../lib/microvm.js';

type HostRoom =
  | { ok: false; error: APIGatewayProxyResultV2 }
  | { ok: true; roomId: string; room: RoomItem };

// Resolve + authorize a host-owned room for a lifecycle action. The Cognito token
// is already verified at the edge by the API Gateway authorizer; we just read the
// claims and confirm ownership of this specific room.
async function hostRoom(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<HostRoom> {
  const roomId = pathParam(event, 'roomId');
  if (!roomId) return { ok: false, error: badRequest('roomId required') };
  const host = hostIdentity(event);
  if (!host) return { ok: false, error: forbidden('host login required') };
  const room = await getRoom(roomId);
  if (!room) return { ok: false, error: notFound('room not found') };
  if (room.host !== host.sub) return { ok: false, error: forbidden('not the room host') };
  return { ok: true, roomId, room };
}

// Host refreshes its own gameplay WS token (host-authorized edge route, distinct
// from the guest's open /tokens/{id}/refresh).
export async function roomsHostToken(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const r = await hostRoom(event);
  if (!r.ok) return r.error;
  const { wsToken, wsTokenExpiresAt } = await mintWsToken(r.room.microvmId);
  const res: RefreshTokenResponse = { wsToken, wsTokenExpiresAt };
  return ok(res);
}

// Host pauses the room: suspend the VM (snapshots RAM+disk; game state is
// preserved) and mark the room SUSPENDED. Clients see the disconnect, check
// status, and wait rather than forcing an auto-resume by reconnecting.
export async function roomsSuspend(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const r = await hostRoom(event);
  if (!r.ok) return r.error;
  if (r.room.status === 'CLOSED' || r.room.status === 'TERMINATED') {
    return badRequest('room is not running');
  }
  // Mark SUSPENDED BEFORE suspending the VM. Otherwise there's a window where the
  // VM is suspending but the room still reads RUNNING — a guest whose socket just
  // dropped would then reconnect, and that ingress traffic auto-resumes the VM,
  // un-pausing the game. We revert to RUNNING if the suspend call fails.
  await setRoomStatus(r.roomId, 'SUSPENDED');
  try {
    await suspendVm(r.room.microvmId);
  } catch (err) {
    await setRoomStatus(r.roomId, 'RUNNING');
    // The VM rejects suspend unless it's RUNNING (e.g. still booting). Surface a
    // clear 409 so the client can tell the host to try again in a moment.
    if (err instanceof Error && err.name === 'ConflictException') {
      return json(409, { error: 'room not ready to pause yet — try again shortly' });
    }
    throw err;
  }
  return ok({ roomId: r.roomId, status: 'SUSPENDED' });
}

// Host resumes a paused room: resume the VM from its snapshot and mark RUNNING.
export async function roomsResume(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
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

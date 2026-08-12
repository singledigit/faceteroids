import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RefreshTokenResponse } from '../lib/contract.js';
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
import { getVmState, mintWsToken, resumeVm, suspendVm } from '../lib/microvm.js';

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
  // un-pausing the game.
  await setRoomStatus(r.roomId, 'SUSPENDED');
  try {
    await suspendVm(r.room.microvmId);
  } catch (err) {
    // The VM rejects suspend unless it's RUNNING. That conflict is ambiguous:
    // "still booting" (revert to RUNNING, host retries) but ALSO "already
    // suspending/suspended" (e.g. a double-clicked Pause). Reverting in the
    // second case would mark a suspended VM RUNNING — guests would reconnect and
    // their ingress auto-resumes the VM, visibly undoing the pause. Reconcile
    // against the VM's actual state instead of assuming.
    if (err instanceof Error && err.name === 'ConflictException') {
      const state = await getVmState(r.room.microvmId);
      if (state === 'SUSPENDING' || state === 'SUSPENDED') {
        // The pause is already happening (double-click) — report success.
        return ok({ roomId: r.roomId, status: 'SUSPENDED' });
      }
      await setRoomStatus(r.roomId, 'RUNNING');
      return json(409, { error: 'room not ready to pause yet — try again shortly' });
    }
    await setRoomStatus(r.roomId, 'RUNNING');
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
    // Resume can fail for reasons that mean OPPOSITE things for the room, so
    // reconcile against the VM's actual state rather than assuming:
    //  - already RUNNING (auto-resumed) — fine, mark the room RUNNING;
    //  - TERMINATED — the idle policy auto-terminates a VM suspended longer than
    //    suspendedDurationSeconds (30 min). Blindly marking RUNNING here would
    //    send every client into an endless reconnect loop against a dead
    //    endpoint. Record the death and tell the host the room is gone.
    const state = await getVmState(r.room.microvmId);
    if (state === 'TERMINATED' || state === 'TERMINATING') {
      await setRoomStatus(r.roomId, 'TERMINATED');
      return json(410, { error: 'room expired while paused (30 min limit) — start a new game' });
    }
    if (state === 'SUSPENDING') {
      // Still mid-suspend (e.g. Resume clicked right after Pause). It can't be
      // resumed until the snapshot completes; keep the room SUSPENDED.
      return json(409, { error: 'room is still pausing — try again shortly' });
    }
    // RUNNING (or PENDING): fall through and mark the room RUNNING.
  }
  await setRoomStatus(r.roomId, 'RUNNING');
  return ok({ roomId: r.roomId, status: 'RUNNING' });
}

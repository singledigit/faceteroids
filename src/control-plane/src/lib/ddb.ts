// DynamoDB single-table access. Item shapes:
//   Room          PK=ROOM#<roomId>          SK=META
//   Guest session PK=GUESTSESSION#<token>   SK=SESSION
// (Host accounts live in Cognito, not here.)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { GameMode, RoomStatus } from './contract.js';
import { REGION, TABLE_NAME } from './config.js';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface RoomItem {
  PK: string;
  SK: 'META';
  roomId: string;
  microvmId: string;
  endpoint: string;
  mode: GameMode;
  host: string; // userId
  status: RoomStatus;
  playerCount: number;
  maxPlayers: number;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number; // TTL (epoch seconds)
}

const roomPK = (roomId: string) => `ROOM#${roomId}`;

export async function getRoom(roomId: string): Promise<RoomItem | null> {
  const res = await doc.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: roomPK(roomId), SK: 'META' },
      // Strongly consistent: a guest checking status right after the host pauses
      // must see SUSPENDED, not a stale RUNNING — otherwise it reconnects and its
      // ingress traffic auto-resumes the VM (un-pausing the game).
      ConsistentRead: true,
    }),
  );
  return (res.Item as RoomItem | undefined) ?? null;
}

export async function putRoom(room: RoomItem): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE_NAME, Item: room }));
}

export async function setRoomStatus(roomId: string, status: RoomStatus): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: roomPK(roomId), SK: 'META' },
      UpdateExpression: 'SET #s = :s, lastSeenAt = :now',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status, ':now': Math.floor(Date.now() / 1000) },
    }),
  );
}

/** Atomically bump playerCount (soft gate; the game server is the true authority). */
export async function adjustPlayerCount(roomId: string, delta: number): Promise<number> {
  const res = await doc.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: roomPK(roomId), SK: 'META' },
      UpdateExpression: 'ADD playerCount :d SET lastSeenAt = :now',
      ExpressionAttributeValues: { ':d': delta, ':now': Math.floor(Date.now() / 1000) },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return (res.Attributes?.playerCount as number | undefined) ?? 0;
}

// ---- Guest sessions ----
// Guests are anonymous, so instead of a signed token we issue a random opaque
// token and keep the binding server-side. This needs no signing secret, is
// revocable (delete the row), and auto-expires via the table's TTL — the
// textbook server-side session, and a cleaner foundation to scale than a
// hand-rolled JWT.

export interface GuestSession {
  PK: string;
  SK: 'SESSION';
  guestId: string;
  roomId: string;
  displayName: string;
  createdAt: number;
  expiresAt: number; // TTL (epoch seconds)
}

const guestPK = (token: string) => `GUESTSESSION#${token}`;

export async function createGuestSession(
  token: string,
  guestId: string,
  roomId: string,
  displayName: string,
  ttlSeconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await doc.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: guestPK(token),
        SK: 'SESSION',
        guestId,
        roomId,
        displayName,
        createdAt: now,
        expiresAt: now + ttlSeconds,
      } satisfies GuestSession,
    }),
  );
}

export async function getGuestSession(token: string): Promise<GuestSession | null> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: guestPK(token), SK: 'SESSION' } }),
  );
  const item = res.Item as GuestSession | undefined;
  // Defensive: honor TTL immediately even if DynamoDB hasn't reaped the row yet
  // (TTL deletion can lag by minutes).
  if (item && item.expiresAt * 1000 <= Date.now()) return null;
  return item ?? null;
}

export { roomPK };

// DynamoDB single-table access. Item shapes follow the plan's data model:
//   User  PK=USER#<username>  SK=PROFILE
//   Room  PK=ROOM#<roomId>    SK=META
//   Guest PK=ROOM#<roomId>    SK=GUEST#<guestId>

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { GameMode, RoomStatus } from '@game/shared';
import { REGION, TABLE_NAME } from './config.js';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface UserItem {
  PK: string;
  SK: 'PROFILE';
  userId: string;
  username: string;
  passwordHash: string;
  createdAt: number;
}

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

const userPK = (username: string) => `USER#${username.toLowerCase()}`;
const roomPK = (roomId: string) => `ROOM#${roomId}`;

export async function getUser(username: string): Promise<UserItem | null> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPK(username), SK: 'PROFILE' } }),
  );
  return (res.Item as UserItem | undefined) ?? null;
}

export async function getRoom(roomId: string): Promise<RoomItem | null> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: roomPK(roomId), SK: 'META' } }),
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

export { userPK, roomPK };

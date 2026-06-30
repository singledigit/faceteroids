import bcrypt from 'bcryptjs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { LoginRequest, LoginResponse } from '@game/shared';
import { HOST_TOKEN_TTL_SECONDS } from '@game/shared';
import { badRequest, ok, parseBody, unauthorized } from '../lib/http.js';
import { getUser } from '../lib/ddb.js';
import { signHost } from '../lib/jwt.js';

export async function authLogin(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody<LoginRequest>(event);
  if (!body?.username || !body?.password) return badRequest('username and password required');

  const user = await getUser(body.username);
  // Always run a real bcrypt comparison so an unknown username takes the same
  // time as a known one (prevents username enumeration via timing). This MUST be
  // a valid cost-12 hash — a malformed string returns instantly and reopens the
  // very leak it's meant to close. It's the hash of a random throwaway value, so
  // no password ever matches it.
  const DUMMY_HASH = '$2a$12$AJ3pQABszd5XB9IWO7IGY.Kf/oMvmBizfw6IFEaGvJulduJRmj7zC';
  const valid = await bcrypt.compare(body.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) return unauthorized('invalid credentials');

  const token = await signHost(user.userId, user.username);
  const res: LoginResponse = {
    token,
    expiresAt: Date.now() + HOST_TOKEN_TTL_SECONDS * 1000,
  };
  return ok(res);
}

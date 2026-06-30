// JWT signing/verification. The HS256 secret lives in SSM Parameter Store
// (SecureString) and is cached for the lifetime of the Lambda execution context.

import jwt from 'jsonwebtoken';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  GUEST_TOKEN_TTL_SECONDS,
  HOST_TOKEN_TTL_SECONDS,
  type Claims,
  type GuestClaims,
  type HostClaims,
} from '@game/shared';
import { JWT_SECRET_PARAM, REGION } from './config.js';

const ssm = new SSMClient({ region: REGION });
let cachedSecret: string | null = null;

async function secret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const res = await ssm.send(
    new GetParameterCommand({ Name: JWT_SECRET_PARAM, WithDecryption: true }),
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error('JWT secret not found in SSM');
  cachedSecret = value;
  return value;
}

export async function signHost(userId: string, username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: HostClaims = {
    sub: userId,
    role: 'host',
    username,
    iat: now,
    exp: now + HOST_TOKEN_TTL_SECONDS,
  };
  return jwt.sign(claims, await secret(), { algorithm: 'HS256' });
}

export async function signGuest(guestId: string, roomId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: GuestClaims = {
    sub: guestId,
    role: 'guest',
    roomId,
    iat: now,
    exp: now + GUEST_TOKEN_TTL_SECONDS,
  };
  return jwt.sign(claims, await secret(), { algorithm: 'HS256' });
}

export async function verify(token: string): Promise<Claims | null> {
  try {
    return jwt.verify(token, await secret(), { algorithms: ['HS256'] }) as Claims;
  } catch {
    return null;
  }
}

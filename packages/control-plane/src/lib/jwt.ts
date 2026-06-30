// Guest-token signing/verification. Guests are anonymous, ephemeral players who
// join via a share link — they are NOT Cognito users. Their room-scoped token is
// a small HS256 JWT signed with a secret from SSM (SecureString), cached for the
// life of the Lambda execution context. Host tokens, by contrast, are issued and
// verified by Cognito (see lib/cognito.ts).

import jwt from 'jsonwebtoken';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { GUEST_TOKEN_TTL_SECONDS, type GuestClaims } from '@game/shared';
import { JWT_SECRET_PARAM, REGION } from './config.js';

const ssm = new SSMClient({ region: REGION });
let cachedSecret: string | null = null;

async function secret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const res = await ssm.send(
    new GetParameterCommand({ Name: JWT_SECRET_PARAM, WithDecryption: true }),
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error('Guest-token secret not found in SSM');
  cachedSecret = value;
  return value;
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

/** Verify a guest token. Returns null for anything that isn't a valid guest JWT. */
export async function verifyGuest(token: string): Promise<GuestClaims | null> {
  try {
    const claims = jwt.verify(token, await secret(), { algorithms: ['HS256'] }) as GuestClaims;
    return claims.role === 'guest' ? claims : null;
  } catch {
    return null;
  }
}

// Host authentication via Amazon Cognito. Self-registration is disabled on the
// pool; accounts are created out-of-band by the admin CLI. Login uses the admin
// auth flow (the Lambda holds AWS creds, the browser never does), and host
// identity on subsequent requests is proved by the Cognito-issued ID token,
// verified against the pool's public JWKS — no shared secret involved.

import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  NotAuthorizedException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { HostClaims } from '@game/shared';
import { COGNITO_CLIENT_ID, COGNITO_USER_POOL_ID, REGION } from './config.js';

const idp = new CognitoIdentityProviderClient({ region: REGION });

// Verifier for ID tokens issued by our pool/client. Caches the JWKS internally.
const verifier = CognitoJwtVerifier.create({
  userPoolId: COGNITO_USER_POOL_ID,
  clientId: COGNITO_CLIENT_ID,
  tokenUse: 'id',
});

export interface HostLogin {
  idToken: string;
  /** Epoch ms when the ID token expires. */
  expiresAt: number;
}

/**
 * Authenticate a host. Returns null on bad credentials / unknown user (callers
 * map that to 401 — and because Cognito handles the comparison, there is no
 * timing oracle to worry about).
 */
export async function loginHost(username: string, password: string): Promise<HostLogin | null> {
  try {
    const res = await idp.send(
      new AdminInitiateAuthCommand({
        UserPoolId: COGNITO_USER_POOL_ID,
        ClientId: COGNITO_CLIENT_ID,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    );
    const idToken = res.AuthenticationResult?.IdToken;
    const expiresIn = res.AuthenticationResult?.ExpiresIn ?? 3600;
    if (!idToken) return null; // e.g. a challenge (new-password) — treat as not-authenticated
    return { idToken, expiresAt: Date.now() + expiresIn * 1000 };
  } catch (err) {
    if (err instanceof NotAuthorizedException || err instanceof UserNotFoundException) {
      return null;
    }
    throw err;
  }
}

/** Verify a Cognito ID token and map it to HostClaims, or null if invalid. */
export async function verifyHostToken(token: string): Promise<HostClaims | null> {
  try {
    const payload = await verifier.verify(token);
    return {
      sub: payload.sub,
      role: 'host',
      username: (payload['cognito:username'] as string) ?? payload.sub,
      iat: payload.iat ?? 0,
      exp: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}

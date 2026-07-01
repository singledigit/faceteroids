// Host login via Amazon Cognito. Self-registration is disabled on the pool;
// accounts are created out-of-band by the admin CLI. Login uses the admin auth
// flow (the Lambda holds AWS creds, the browser never does). NOTE: host tokens
// on later requests are verified by the API Gateway Cognito JWT authorizer at
// the edge — not here — so this module only mints the token at login time.

import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  NotAuthorizedException,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';
import { COGNITO_CLIENT_ID, COGNITO_USER_POOL_ID, REGION } from './config.js';

const idp = new CognitoIdentityProviderClient({ region: REGION });

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

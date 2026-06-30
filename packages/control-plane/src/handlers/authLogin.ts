import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { LoginRequest, LoginResponse } from '@game/shared';
import { badRequest, ok, parseBody, unauthorized } from '../lib/http.js';
import { loginHost } from '../lib/cognito.js';

// Host login against Cognito (self-registration disabled; accounts are created by
// the admin CLI). Returns the Cognito ID token, which the client sends as a
// Bearer token on subsequent control-plane calls.
export async function authLogin(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseBody<LoginRequest>(event);
  if (!body?.username || !body?.password) return badRequest('username and password required');

  const result = await loginHost(body.username, body.password);
  if (!result) return unauthorized('invalid credentials');

  const res: LoginResponse = { token: result.idToken, expiresAt: result.expiresAt };
  return ok(res);
}

// Helpers for API Gateway HTTP API (v2) Lambda handlers: JSON responses with CORS,
// body parsing, and identity extraction.
//
// Auth is NOT hand-rolled here. Hosts are authenticated by an API Gateway Cognito
// JWT authorizer at the edge — by the time a host route's Lambda runs, the token
// is already verified and the claims are on the event. Guests present an opaque
// session token that we look up in DynamoDB.

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { getGuestSession, type GuestSession } from './ddb.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

export function ok(body: unknown): APIGatewayProxyResultV2 {
  return json(200, body);
}
export function badRequest(msg: string): APIGatewayProxyResultV2 {
  return json(400, { error: msg });
}
export function unauthorized(msg = 'unauthorized'): APIGatewayProxyResultV2 {
  return json(401, { error: msg });
}
export function forbidden(msg = 'forbidden'): APIGatewayProxyResultV2 {
  return json(403, { error: msg });
}
export function notFound(msg = 'not found'): APIGatewayProxyResultV2 {
  return json(404, { error: msg });
}

export function parseBody<T>(event: APIGatewayProxyEventV2): T | null {
  if (!event.body) return null;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface HostIdentity {
  /** Cognito sub (stable user id). */
  sub: string;
  username: string;
}

/**
 * Identity of the host on a route protected by the API Gateway Cognito authorizer.
 * The token is already verified at the edge; we just read the claims. Returns null
 * only if somehow invoked without the authorizer (defensive).
 */
export function hostIdentity(event: APIGatewayProxyEventV2WithJWTAuthorizer): HostIdentity | null {
  const claims = event.requestContext.authorizer?.jwt?.claims as
    | Record<string, string>
    | undefined;
  if (!claims?.sub) return null;
  return { sub: claims.sub, username: claims['cognito:username'] ?? claims.sub };
}

/** Look up the guest's opaque session token (Authorization: Bearer <token>). */
export async function guestSession(event: APIGatewayProxyEventV2): Promise<GuestSession | null> {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return getGuestSession(header.slice(7));
}

export function pathParam(event: APIGatewayProxyEventV2, name: string): string | undefined {
  return event.pathParameters?.[name];
}

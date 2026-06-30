// Helpers for API Gateway HTTP API (v2) Lambda handlers: JSON responses with CORS,
// body parsing, and bearer-token extraction + verification into typed claims.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import type { Claims } from '@game/shared';
import { verifyGuest } from './jwt.js';
import { verifyHostToken } from './cognito.js';

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

/**
 * Extract and verify the Bearer token. Two issuers: hosts present a Cognito ID
 * token (RS256, verified against the pool JWKS); guests present our own ephemeral
 * HS256 token. We try host first, then guest.
 */
export async function authClaims(event: APIGatewayProxyEventV2): Promise<Claims | null> {
  const header = event.headers?.authorization ?? event.headers?.Authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return (await verifyHostToken(token)) ?? (await verifyGuest(token));
}

export function pathParam(event: APIGatewayProxyEventV2, name: string): string | undefined {
  return event.pathParameters?.[name];
}

// Single Lambda handler fronting the HTTP API. API Gateway routes all paths here;
// we dispatch on the v2 routeKey ("METHOD /path"). A monolithic router keeps the
// deploy simple (one function, one bundle) while handlers stay modular.

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { json } from './lib/http.js';
import { authLogin } from './handlers/authLogin.js';
import { roomsCreate } from './handlers/roomsCreate.js';
import { roomsJoin } from './handlers/roomsJoin.js';
import { roomsStatus } from './handlers/roomsStatus.js';
import { tokensRefresh } from './handlers/tokensRefresh.js';
import { roomsClose } from './handlers/roomsClose.js';

type Handler = (e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2>;

const ROUTES: Record<string, Handler> = {
  'POST /auth/login': authLogin,
  'POST /rooms': roomsCreate,
  'GET /rooms/{roomId}': roomsStatus,
  'POST /rooms/{roomId}/join': roomsJoin,
  'POST /rooms/{roomId}/close': roomsClose,
  'POST /tokens/{roomId}/refresh': tokensRefresh,
};

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const routeKey = event.routeKey ?? `${event.requestContext?.http?.method} ${event.rawPath}`;

  // CORS preflight.
  if (event.requestContext?.http?.method === 'OPTIONS') return json(204, {});

  const route = ROUTES[routeKey];
  if (!route) return json(404, { error: `no route for ${routeKey}` });

  try {
    return await route(event);
  } catch (err) {
    console.error('handler error', routeKey, err);
    return json(500, { error: 'internal error' });
  }
}

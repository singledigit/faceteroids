// Single Lambda handler fronting the HTTP API. API Gateway routes all paths here;
// we dispatch on the v2 routeKey ("METHOD /path"). A monolithic router keeps the
// deploy simple (one function, one bundle) while handlers stay modular.

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { json } from './lib/http.js';
import { authLogin } from './handlers/authLogin.js';
import { roomsCreate } from './handlers/roomsCreate.js';
import { roomsJoin } from './handlers/roomsJoin.js';
import { roomsStatus } from './handlers/roomsStatus.js';
import { tokensRefresh } from './handlers/tokensRefresh.js';
import { roomsClose } from './handlers/roomsClose.js';
import { roomsSuspend, roomsResume, roomsHostToken } from './handlers/roomsLifecycle.js';

// The runtime event carries the JWT authorizer context on host routes; public
// routes simply ignore it. Handlers narrow to the type they need.
type Ev = APIGatewayProxyEventV2WithJWTAuthorizer;
type Handler = (e: Ev) => Promise<APIGatewayProxyResultV2>;

const ROUTES: Record<string, Handler> = {
  // Public (no edge authorizer): login, guest join/status/refresh.
  'POST /auth/login': authLogin,
  'GET /rooms/{roomId}': roomsStatus,
  'POST /rooms/{roomId}/join': roomsJoin,
  'POST /tokens/{roomId}/refresh': tokensRefresh,
  // Host-only (Cognito JWT authorizer at the edge).
  'POST /rooms': roomsCreate,
  'POST /rooms/{roomId}/close': roomsClose,
  'POST /rooms/{roomId}/suspend': roomsSuspend,
  'POST /rooms/{roomId}/resume': roomsResume,
  'POST /rooms/{roomId}/token': roomsHostToken,
};

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
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

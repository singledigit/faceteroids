// Runtime configuration for the control-plane Lambdas. All deployment-specific
// values are injected as environment variables by the CDK ApiStack — there are
// no baked-in account IDs or ARNs. Missing required values fail fast at cold
// start rather than silently constructing malformed ARNs.

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const REGION = process.env.AWS_REGION ?? 'us-west-2';
export const TABLE_NAME = required('TABLE_NAME');
export const MICROVM_IMAGE_ARN = required('MICROVM_IMAGE_ARN');
export const EXECUTION_ROLE_ARN = required('EXECUTION_ROLE_ARN');
// Cognito host pool (self-registration disabled). Host tokens are verified at the
// API Gateway edge by a JWT authorizer; the Lambda only calls Cognito to log in.
export const COGNITO_USER_POOL_ID = required('COGNITO_USER_POOL_ID');
export const COGNITO_CLIENT_ID = required('COGNITO_CLIENT_ID');
/** Base URL of the static web client, used to build shareable join links. */
export const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'http://localhost:5173';

export const GAME_PORT = 8080;
/** Hard lifetime cap for a room's MicroVM (8h). */
export const ROOM_MAX_DURATION_SECONDS = 28800;
/** WS auth token TTL (platform max is 60 min). */
export const WS_TOKEN_TTL_MINUTES = 60;
/** Guest session lifetime — matches the room's max lifetime; TTL auto-cleans. */
export const GUEST_SESSION_TTL_SECONDS = ROOM_MAX_DURATION_SECONDS;

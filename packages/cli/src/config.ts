// CLI configuration. Region/account come from the environment (no baked-in
// account ID — see .env.example). The artifact bucket and role ARNs are resolved
// at runtime from the deployed CloudFormation stack outputs where possible.

/** Resolve the AWS account ID from the environment, failing fast if unset. */
function requireAccountId(): string {
  const id = process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT;
  if (!id) {
    throw new Error(
      'AWS_ACCOUNT_ID is required. Export it (e.g. `export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)`) — see .env.example.',
    );
  }
  return id;
}

export const REGION = process.env.AWS_REGION ?? 'us-west-2';
export const ACCOUNT_ID = requireAccountId();
export const BASE_IMAGE_ARN = `arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1`;
export const MICROVM_IMAGE_NAME = process.env.MICROVM_IMAGE_NAME ?? 'asteroids';
/** Full ARN — required by Get/Update/Run operations (Create takes the bare name). */
export const MICROVM_IMAGE_ARN = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:microvm-image:${MICROVM_IMAGE_NAME}`;
export const TABLE_NAME = process.env.TABLE_NAME ?? 'AsteroidsGame';
export const BUILD_ROLE_ARN =
  process.env.BUILD_ROLE_ARN ?? `arn:aws:iam::${ACCOUNT_ID}:role/AsteroidsMicroVmBuildRole`;
export const DATA_STACK = 'AsteroidsData';
export const IAM_STACK = 'AsteroidsIam';

/** Gameplay + hooks ports inside the MicroVM. */
export const GAME_PORT = 8080;
export const HOOK_PORT = 9000;

/** SSM SecureString holding the JWT signing secret. */
export const JWT_SECRET_PARAM = process.env.JWT_SECRET_PARAM ?? '/asteroids/jwt-secret';

// Central infra configuration. Region is pinned: the artifact bucket, MicroVM
// image, and running VMs must all co-locate in one region.

export const REGION = process.env.CDK_DEFAULT_REGION ?? 'us-west-2';
export const ACCOUNT = process.env.CDK_DEFAULT_ACCOUNT;

/** Lambda-managed base image confirmed available in us-west-2. */
export const BASE_IMAGE_ARN = `arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1`;

/** Name of the MicroVM image the CLI build pipeline creates and RunMicrovm references. */
export const MICROVM_IMAGE_NAME = 'asteroids';

export const STACK_PREFIX = 'Asteroids';

/** Single-table DynamoDB name (also referenced by control-plane + CLI). */
export const TABLE_NAME = 'AsteroidsGame';

export const env = { account: ACCOUNT, region: REGION };

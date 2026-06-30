#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';
import { IamStack } from '../lib/iam-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { env, STACK_PREFIX } from '../lib/config.js';

const app = new App();

const data = new DataStack(app, `${STACK_PREFIX}Data`, { env });

const iam = new IamStack(app, `${STACK_PREFIX}Iam`, {
  env,
  artifactBucket: data.artifactBucket,
});

new ApiStack(app, `${STACK_PREFIX}Api`, {
  env,
  table: data.table,
  executionRole: iam.executionRole,
});

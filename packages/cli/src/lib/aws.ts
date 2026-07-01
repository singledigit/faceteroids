// Thin AWS SDK v3 client factories + a CloudFormation output resolver, shared by
// CLI commands.

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { LambdaMicrovms } from '@aws-sdk/client-lambda-microvms';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { REGION } from '../config.js';

export const microvms = new LambdaMicrovms({ region: REGION });
export const cfn = new CloudFormationClient({ region: REGION });
export const cognito = new CognitoIdentityProviderClient({ region: REGION });

/** Resolve a CloudFormation stack output value by logical-ish key match. */
export async function stackOutput(stackName: string, outputKeyContains: string): Promise<string> {
  const res = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  const match = outputs.find((o) => (o.OutputKey ?? '').includes(outputKeyContains));
  if (!match?.OutputValue) {
    throw new Error(`Output containing "${outputKeyContains}" not found on stack ${stackName}`);
  }
  return match.OutputValue;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Thin AWS SDK v3 client factories + a CloudFormation output resolver, shared by
// CLI commands.

import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { LambdaMicrovms } from '@aws-sdk/client-lambda-microvms';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { REGION } from '../config.js';

export const microvms = new LambdaMicrovms({ region: REGION });
export const s3 = new S3Client({ region: REGION });
export const cfn = new CloudFormationClient({ region: REGION });

const ddbBase = new DynamoDBClient({ region: REGION });
export const ddb = DynamoDBDocumentClient.from(ddbBase, {
  marshallOptions: { removeUndefinedValues: true },
});

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

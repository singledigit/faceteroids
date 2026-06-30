// Set the JWT signing secret (SSM SecureString). Run once after the API stack is
// deployed, before issuing logins. Generates a strong random secret if none given.

import { randomBytes } from 'node:crypto';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import { JWT_SECRET_PARAM, REGION } from '../config.js';

const ssm = new SSMClient({ region: REGION });

export async function setSecret(value?: string): Promise<void> {
  const secret = value ?? randomBytes(48).toString('base64url');
  await ssm.send(
    new PutParameterCommand({
      Name: JWT_SECRET_PARAM,
      Value: secret,
      Type: 'SecureString',
      Overwrite: true,
    }),
  );
  console.log(`Set ${JWT_SECRET_PARAM} (${secret.length} chars).`);
}

// Host-user provisioning. This is the ONLY way host accounts are created — there
// is no public registration. Uses the developer's admin AWS credentials.

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import bcrypt from 'bcryptjs';
import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/aws.js';
import { TABLE_NAME } from '../config.js';

const BCRYPT_COST = 12;
const userPK = (username: string) => `USER#${username.toLowerCase()}`;

export async function createUser(username?: string): Promise<void> {
  if (!username) throw new Error('usage: create-user <username>');

  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { PK: userPK(username), SK: 'PROFILE' } }),
  );
  if (existing.Item) throw new Error(`user "${username}" already exists`);

  const password = await promptPassword(`Password for ${username}: `);
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const confirm = await promptPassword('Confirm password: ');
  if (password !== confirm) throw new Error('passwords do not match');

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: userPK(username),
        SK: 'PROFILE',
        userId: randomUUID(),
        username,
        passwordHash,
        createdAt: Math.floor(Date.now() / 1000),
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  console.log(`Created host user "${username}".`);
}

export async function listUsers(): Promise<void> {
  // Single-table with no user GSI, so we Scan for PROFILE rows. Fine for an admin
  // CLI over a small user set; a production system would add a GSI instead.
  const res = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'SK = :p',
      ExpressionAttributeValues: { ':p': 'PROFILE' },
      ProjectionExpression: 'username, createdAt',
    }),
  );
  const users = (res.Items ?? []) as Array<{ username: string; createdAt: number }>;
  if (users.length === 0) {
    console.log('No host users. Create one with: game-admin create-user <username>');
    return;
  }
  for (const u of users.sort((a, b) => a.username.localeCompare(b.username))) {
    console.log(`${u.username}\t(created ${new Date(u.createdAt * 1000).toISOString()})`);
  }
}

export async function deleteUser(username?: string): Promise<void> {
  if (!username) throw new Error('usage: delete-user <username>');
  await ddb.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: userPK(username), SK: 'PROFILE' } }),
  );
  console.log(`Deleted user "${username}" (if it existed).`);
}

/** Read a password from the TTY without echoing it. */
function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const muted = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });
    process.stdout.write(prompt);
    const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question('', (answer) => {
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

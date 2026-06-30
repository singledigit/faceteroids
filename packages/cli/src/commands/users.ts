// Host-user provisioning via Amazon Cognito. This is the ONLY way host accounts
// are created — the user pool has self-registration disabled. Uses the
// developer's admin AWS credentials. The pool ID is resolved from the deployed
// AsteroidsApi stack output.

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminDeleteUserCommand,
  ListUsersCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { cognito, stackOutput } from '../lib/aws.js';
import { API_STACK } from '../config.js';

async function poolId(): Promise<string> {
  return stackOutput(API_STACK, 'UserPoolId');
}

export async function createUser(username?: string): Promise<void> {
  if (!username) throw new Error('usage: create-user <username>');
  const UserPoolId = await poolId();

  const password = await promptPassword(`Password for ${username}: `);
  if (password.length < 8) throw new Error('password must be at least 8 characters');
  const confirm = await promptPassword('Confirm password: ');
  if (password !== confirm) throw new Error('passwords do not match');

  try {
    // Create with no invite email/SMS, then set a permanent password so the user
    // can log in immediately (no FORCE_CHANGE_PASSWORD challenge).
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId,
        Username: username,
        MessageAction: 'SUPPRESS',
      }),
    );
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId,
        Username: username,
        Password: password,
        Permanent: true,
      }),
    );
    console.log(`Created host user "${username}".`);
  } catch (err) {
    if (err instanceof UsernameExistsException) throw new Error(`user "${username}" already exists`);
    throw err;
  }
}

export async function listUsers(): Promise<void> {
  const UserPoolId = await poolId();
  const res = await cognito.send(new ListUsersCommand({ UserPoolId }));
  const users = res.Users ?? [];
  if (users.length === 0) {
    console.log('No host users. Create one with: game-admin create-user <username>');
    return;
  }
  for (const u of users) {
    console.log(`${u.Username}\t${u.UserStatus}\t(created ${u.UserCreateDate?.toISOString()})`);
  }
}

export async function deleteUser(username?: string): Promise<void> {
  if (!username) throw new Error('usage: delete-user <username>');
  const UserPoolId = await poolId();
  await cognito.send(new AdminDeleteUserCommand({ UserPoolId, Username: username }));
  console.log(`Deleted user "${username}".`);
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

#!/usr/bin/env node
// Admin CLI. Uses the developer's own AWS credentials (admin), NOT the
// control-plane role.

import { buildImage } from './commands/buildImage.js';
import { runRoom } from './commands/runRoom.js';
import { createUser, deleteUser, listUsers } from './commands/users.js';
import { setSecret } from './commands/secret.js';
import { pruneImages } from './commands/pruneImages.js';

function usage(): never {
  console.log(`game-admin <command>

  build-image                 Bundle, upload, and build the MicroVM image (-> ACTIVE)
  set-secret   [value]        Set the guest-token signing secret in SSM (random if omitted)
  create-user  <username> [password]  Create a host user (prompts if password omitted)
  list-users                  List host usernames
  delete-user  <username>     Delete a host user
  run-room     [mode]         Manually RunMicrovm + mint a token (data-plane test)
  prune-images                Delete old image versions (keep latest ACTIVE)
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'build-image':
      await buildImage();
      break;
    case 'set-secret':
      await setSecret(args[0]);
      break;
    case 'create-user':
      await createUser(args[0], args[1]);
      break;
    case 'list-users':
      await listUsers();
      break;
    case 'delete-user':
      await deleteUser(args[0]);
      break;
    case 'run-room':
      await runRoom(args[0]);
      break;
    case 'prune-images':
      await pruneImages();
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

// Image build pipeline: bundle the game server, zip it with the Dockerfile at the
// archive root, probe MicroVM availability, upload to S3, CreateMicrovmImage with
// the lifecycle hooks enabled, poll the version to SUCCESSFUL, then mark it ACTIVE
// so RunMicrovm resolves it without an explicit version.
//
// Run as a developer/CI step (NOT a CDK custom resource) — image builds are slow,
// versioned, and shouldn't gate infra deploys.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  ListMicrovmImagesCommand,
  UpdateMicrovmImageCommand,
  UpdateMicrovmImageVersionCommand,
  type Hooks,
} from '@aws-sdk/client-lambda-microvms';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { microvms, s3, stackOutput, sleep } from '../lib/aws.js';
import {
  BASE_IMAGE_ARN,
  BUILD_ROLE_ARN,
  DATA_STACK,
  GAME_PORT,
  HOOK_PORT,
  MICROVM_IMAGE_ARN,
  MICROVM_IMAGE_NAME,
  REGION,
} from '../config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/cli/src/commands -> repo root
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const GAME_SERVER_DIR = join(REPO_ROOT, 'packages', 'game-server');

export async function buildImage(): Promise<void> {
  // 1. Availability probe — fail fast if MicroVMs aren't usable in this region.
  console.log(`[build] probing MicroVM availability in ${REGION}…`);
  await microvms.send(new ListMicrovmImagesCommand({}));
  console.log('[build] MicroVMs available.');

  // 2. Bundle the server (esbuild) into a single self-contained file.
  console.log('[build] bundling game server…');
  execFileSync('npm', ['run', 'bundle', '--workspace', '@game/game-server'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  const bundlePath = join(GAME_SERVER_DIR, 'dist', 'bundle.mjs');
  const dockerfilePath = join(GAME_SERVER_DIR, 'Dockerfile');
  if (!existsSync(bundlePath) || !existsSync(dockerfilePath)) {
    throw new Error('Bundle or Dockerfile missing after build');
  }

  // 3. Zip with the Dockerfile at the archive ROOT (CreateMicrovmImage requires it).
  //    Layout inside the zip: ./Dockerfile and ./dist/bundle.mjs (matches Dockerfile COPY).
  const stamp = gitSha() ?? String(Date.now());
  const zipPath = join(REPO_ROOT, `asteroids-${stamp}.zip`);
  console.log('[build] creating artifact zip…');
  execFileSync('zip', ['-j', zipPath, dockerfilePath], { stdio: 'inherit' });
  execFileSync('zip', [zipPath, 'dist/bundle.mjs'], { cwd: GAME_SERVER_DIR, stdio: 'inherit' });

  // 4. Upload to the artifact bucket (resolved from the deployed stack).
  const bucket = await stackOutput(DATA_STACK, 'ArtifactBucketName');
  const key = `microvm-images/asteroids-${stamp}.zip`;
  console.log(`[build] uploading to s3://${bucket}/${key}…`);
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(zipPath) }),
  );

  // 5. Create the image, or add a new version if it already exists. Hooks:
  //    ready/validate at build; run/resume/suspend/terminate at runtime. The SDK
  //    puts hooks + env at the top level (the CLI nests them under --runtime).
  const common = {
    baseImageArn: BASE_IMAGE_ARN,
    buildRoleArn: BUILD_ROLE_ARN,
    codeArtifact: { uri: `s3://${bucket}/${key}` },
    description: 'Multiplayer Asteroids game server',
    environmentVariables: {
      GAME_PORT: String(GAME_PORT),
      HOOK_PORT: String(HOOK_PORT),
      HOOKS_ENABLED: 'true',
      NODE_ENV: 'production',
    },
    hooks: HOOKS,
  };

  const exists = await imageExists();
  let imageArn: string;
  let version: string;
  if (exists) {
    console.log('[build] image exists — UpdateMicrovmImage (new version)…');
    const updated = await microvms.send(
      new UpdateMicrovmImageCommand({ imageIdentifier: MICROVM_IMAGE_ARN, ...common }),
    );
    imageArn = updated.imageArn!;
    version = updated.imageVersion!;
  } else {
    console.log('[build] CreateMicrovmImage…');
    const created = await microvms.send(
      new CreateMicrovmImageCommand({ name: MICROVM_IMAGE_NAME, ...common }),
    );
    imageArn = created.imageArn!;
    version = created.imageVersion!;
  }
  console.log(`[build] imageArn=${imageArn} version=${version}`);

  // 6. Poll this version until SUCCESSFUL/FAILED.
  await pollVersion(imageArn, version);
  console.log(`[build] version ${version} SUCCESSFUL — marking ACTIVE`);

  // 7. Mark ACTIVE so RunMicrovm resolves it without an explicit version.
  await microvms.send(
    new UpdateMicrovmImageVersionCommand({
      imageIdentifier: imageArn,
      imageVersion: version,
      status: 'ACTIVE',
    }),
  );
  console.log(`[build] DONE. imageArn=${imageArn} version=${version} (ACTIVE)`);
}

/** Lifecycle hooks config — shared by create and update. */
const HOOKS: Hooks = {
  port: HOOK_PORT,
  microvmImageHooks: {
    ready: 'ENABLED',
    readyTimeoutInSeconds: 60,
    validate: 'ENABLED',
    validateTimeoutInSeconds: 20,
  },
  microvmHooks: {
    run: 'ENABLED',
    runTimeoutInSeconds: 5,
    resume: 'ENABLED',
    resumeTimeoutInSeconds: 5,
    suspend: 'ENABLED',
    suspendTimeoutInSeconds: 5,
    terminate: 'ENABLED',
    terminateTimeoutInSeconds: 5,
  },
};

async function imageExists(): Promise<boolean> {
  try {
    await microvms.send(new GetMicrovmImageCommand({ imageIdentifier: MICROVM_IMAGE_ARN }));
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') return false;
    throw err;
  }
}

async function pollVersion(imageArn: string, version: string): Promise<void> {
  const start = Date.now();
  const TIMEOUT_MS = 20 * 60 * 1000;
  while (Date.now() - start < TIMEOUT_MS) {
    const res = await microvms.send(
      new GetMicrovmImageVersionCommand({ imageIdentifier: imageArn, imageVersion: version }),
    );
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[build] version ${version} state=${res.state} (${elapsed}s)`);
    if (res.state === 'SUCCESSFUL') return;
    if (res.state === 'FAILED') {
      throw new Error(`Image build FAILED: ${res.stateReason ?? 'unknown'}`);
    }
    await sleep(15000);
  }
  throw new Error('Image build timed out');
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

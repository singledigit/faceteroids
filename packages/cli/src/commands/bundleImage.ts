// LOCAL image prep only — bundles the game server, zips it with the Dockerfile at
// the archive root, and uploads the artifact to S3. It does NOT call the Lambda
// MicroVMs image API: that's done with explicit `aws lambda-microvms
// create-microvm-image` / `update-microvm-image` calls (see the README), so the
// service operation that actually builds the image stays visible, not wrapped.
//
// Prints the resulting s3:// URI to paste into --code-artifact.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, stackOutput } from '../lib/aws.js';
import { DATA_STACK } from '../config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const GAME_SERVER_DIR = join(REPO_ROOT, 'packages', 'game-server');

export async function bundleImage(): Promise<void> {
  // 1. Bundle the server (esbuild) into a single self-contained file.
  console.log('[bundle] bundling game server…');
  execFileSync('npm', ['run', 'bundle', '--workspace', '@game/game-server'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  const bundlePath = join(GAME_SERVER_DIR, 'dist', 'bundle.mjs');
  const dockerfilePath = join(GAME_SERVER_DIR, 'Dockerfile');
  if (!existsSync(bundlePath) || !existsSync(dockerfilePath)) {
    throw new Error('Bundle or Dockerfile missing after build');
  }

  // 2. Zip with the Dockerfile at the archive ROOT (CreateMicrovmImage requires it).
  //    Layout inside the zip: ./Dockerfile and ./dist/bundle.mjs (matches Dockerfile COPY).
  const stamp = gitSha() ?? String(Date.now());
  const zipPath = join(REPO_ROOT, `asteroids-${stamp}.zip`);
  console.log('[bundle] creating artifact zip…');
  execFileSync('zip', ['-j', zipPath, dockerfilePath], { stdio: 'inherit' });
  execFileSync('zip', [zipPath, 'dist/bundle.mjs'], { cwd: GAME_SERVER_DIR, stdio: 'inherit' });

  // 3. Upload to the artifact bucket (resolved from the deployed data stack).
  const bucket = await stackOutput(DATA_STACK, 'ArtifactBucketName');
  const key = `microvm-images/asteroids-${stamp}.zip`;
  console.log(`[bundle] uploading to s3://${bucket}/${key}…`);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: readFileSync(zipPath) }));

  console.log('\nArtifact uploaded. Build the MicroVM image with:\n');
  console.log(`  CODE_ARTIFACT=s3://${bucket}/${key}`);
  console.log('  (see README "Deploy" — aws lambda-microvms create-microvm-image)\n');
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

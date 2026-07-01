#!/usr/bin/env bash
# build:back — package the game server that runs INSIDE each MicroVM, then build
# (or update) the MicroVM image with an explicit Lambda MicroVMs service call.
#
# Local prep is just esbuild + zip + S3 upload; the image itself is compiled by
# the Lambda MicroVMs service from the Dockerfile in the zip (no local Docker).
# Requires the SAM stack to be deployed first (reads its outputs).
set -euo pipefail

STACK="${STACK_NAME:-asteroids}"
REGION="${AWS_REGION:-us-west-2}"
IMAGE_NAME="${IMAGE_NAME:-asteroids}"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ARTIFACT_BUCKET=$(output ArtifactBucketName)
BUILD_ROLE=$(output BuildRoleArn)
IMG_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:microvm-image:${IMAGE_NAME}"
BASE_IMAGE="arn:aws:lambda:${REGION}:aws:microvm-image:al2023-1"

# 1. Bundle the game server (esbuild) into one self-contained file.
echo "build:back  bundling game server…"
npm run bundle --prefix gameserver

GS=gameserver
STAMP="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
ZIP="asteroids-${STAMP}.zip"

# 2. Zip with the Dockerfile at the archive ROOT (CreateMicrovmImage requires it).
echo "build:back  zipping (Dockerfile at root + dist/bundle.mjs)…"
rm -f "$ZIP"
zip -j "$ZIP" "$GS/Dockerfile" >/dev/null
( cd "$GS" && zip "$OLDPWD/$ZIP" dist/bundle.mjs >/dev/null )

# 3. Upload the artifact.
KEY="microvm-images/asteroids-${STAMP}.zip"
echo "build:back  uploading s3://${ARTIFACT_BUCKET}/${KEY}…"
aws s3 cp "$ZIP" "s3://${ARTIFACT_BUCKET}/${KEY}" --region "$REGION"
rm -f "$ZIP"
CODE_ARTIFACT="s3://${ARTIFACT_BUCKET}/${KEY}"

ENV_VARS='{"GAME_PORT":"8080","HOOK_PORT":"9000","HOOKS_ENABLED":"true","NODE_ENV":"production"}'
HOOKS="$(cat "$GS/image-runtime.json")"

# 4. Create the image, or add a version if it already exists — the real service call.
if aws lambda-microvms get-microvm-image --region "$REGION" --image-identifier "$IMG_ARN" >/dev/null 2>&1; then
  echo "build:back  image exists → update-microvm-image (new version)…"
  RES=$(aws lambda-microvms update-microvm-image --region "$REGION" \
    --image-identifier "$IMG_ARN" --base-image-arn "$BASE_IMAGE" --build-role-arn "$BUILD_ROLE" \
    --code-artifact "{\"uri\":\"$CODE_ARTIFACT\"}" --hooks "$HOOKS" --environment-variables "$ENV_VARS")
else
  echo "build:back  create-microvm-image…"
  RES=$(aws lambda-microvms create-microvm-image --region "$REGION" \
    --name "$IMAGE_NAME" --base-image-arn "$BASE_IMAGE" --build-role-arn "$BUILD_ROLE" \
    --code-artifact "{\"uri\":\"$CODE_ARTIFACT\"}" --hooks "$HOOKS" --environment-variables "$ENV_VARS")
fi
VERSION=$(echo "$RES" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).imageVersion))')
echo "build:back  building image version ${VERSION}…"

# 5. Poll until SUCCESSFUL, then mark ACTIVE so RunMicrovm resolves it.
while :; do
  STATE=$(aws lambda-microvms get-microvm-image-version --region "$REGION" \
    --image-identifier "$IMG_ARN" --image-version "$VERSION" --query 'state' --output text)
  echo "build:back    version ${VERSION} state=${STATE}"
  [ "$STATE" = "SUCCESSFUL" ] && break
  [ "$STATE" = "FAILED" ] && { echo "image build FAILED"; exit 1; }
  sleep 15
done
aws lambda-microvms update-microvm-image-version --region "$REGION" \
  --image-identifier "$IMG_ARN" --image-version "$VERSION" --status ACTIVE >/dev/null
echo "build:back  DONE — ${IMG_ARN} version ${VERSION} (ACTIVE)"

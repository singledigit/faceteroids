#!/usr/bin/env bash
# build:front — build the web client, point it at the deployed API via a runtime
# config.json, and push it to the S3 bucket behind CloudFront.
#
# Requires the SAM stack to be deployed first (reads its outputs). With CloudFront
# caching disabled, no invalidation is needed.
set -euo pipefail

STACK="${STACK_NAME:-asteroids}"
REGION="${AWS_REGION:-us-west-2}"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

API_URL=$(output ApiUrl)
WEB_BUCKET=$(output WebBucketName)
WEB_URL=$(output WebUrl)
echo "build:front  api=$API_URL  bucket=$WEB_BUCKET"

# 1. Build the static client.
npx vite build frontend

# 2. Runtime config so the env-agnostic bundle finds the API (no rebuild on change).
printf '{"apiUrl":"%s"}\n' "$API_URL" > frontend/dist/config.json

# 3. Push to S3 (CloudFront serves it; caching is disabled, so this is live at once).
aws s3 cp frontend/dist "s3://$WEB_BUCKET" --recursive --region "$REGION"

echo "Deployed front end → $WEB_URL"

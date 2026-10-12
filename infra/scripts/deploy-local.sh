#!/usr/bin/env bash
# Deploys the real CDK stack into LocalStack (no AWS account needed) and writes ../.env.local
# for the API. Requires `docker compose up -d --wait localstack` first.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-1
export CDK_DISABLE_VERSION_CHECK=1 CDK_NOTICES=false

OUT=../cdk-outputs.local.json
npx cdklocal bootstrap "aws://${CDK_DEFAULT_ACCOUNT}/${CDK_DEFAULT_REGION}" -c local=true
npx cdklocal deploy UploadPipeline --require-approval never -c local=true --outputs-file "$OUT"
npx tsx ../scripts/write-env.ts "$OUT" ../.env.local

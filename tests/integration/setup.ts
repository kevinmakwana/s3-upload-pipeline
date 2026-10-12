import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Point every AWS client at the LocalStack deployment described by the CDK outputs. */
const file = process.env.CDK_OUTPUTS ?? resolve(__dirname, '../../cdk-outputs.local.json');
let outputs: Record<string, string>;
try {
  outputs = Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>)[0]!;
} catch {
  throw new Error(`Cannot read ${file}. Start LocalStack and run \`npm run localstack:up && npm run localstack:deploy\` first.`);
}

Object.assign(process.env, {
  AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  S3_FORCE_PATH_STYLE: 'true',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  BUCKET_NAME: outputs.BucketName,
  TABLE_NAME: outputs.TableName,
  QUEUE_URL: outputs.QueueUrl,
  DLQ_URL: outputs.DlqUrl,
});

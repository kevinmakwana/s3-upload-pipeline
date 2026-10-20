import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Point the smoke test at a stack deployed to real AWS. Unlike the integration setup there is no
 * endpoint override and no dummy credentials: the SDK's normal credential chain applies.
 */
const file = process.env.CDK_OUTPUTS ?? resolve(__dirname, '../../cdk-outputs.aws.json');
let outputs: Record<string, string>;
try {
  outputs = Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, string>>)[0]!;
} catch {
  throw new Error(
    `Cannot read ${file}. Deploy with \`npx cdk deploy ... --outputs-file ../cdk-outputs.aws.json\` (from infra/), or set CDK_OUTPUTS to a file shaped like {"<Stack>": {"BucketName": "..."}}.`,
  );
}
if (process.env.AWS_ENDPOINT_URL) {
  throw new Error('AWS_ENDPOINT_URL is set, so this would not test real AWS. Unset it (the integration tests are the LocalStack ones).');
}
if (!process.env.AWS_REGION) throw new Error('Set AWS_REGION to the region the stack is deployed in.');
for (const name of ['BucketName', 'TableName']) {
  if (!outputs[name]) throw new Error(`The stack outputs have no ${name}`);
}

Object.assign(process.env, {
  BUCKET_NAME: outputs.BucketName,
  TABLE_NAME: outputs.TableName,
  API_POLICY_ARN: outputs.ApiPolicyArn ?? '',
});

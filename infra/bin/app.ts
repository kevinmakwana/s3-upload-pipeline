import { App } from 'aws-cdk-lib';
import { UploadPipelineStack } from '../lib/upload-pipeline-stack';

const app = new App();
const flag = (name: string) => String(app.node.tryGetContext(name)) === 'true';

new UploadPipelineStack(app, 'UploadPipeline', {
  // `-c local=true` targets LocalStack: no Fargate, disposable resources.
  local: flag('local'),
  // `-c deployApi=true` adds the NestJS API on Fargate behind an ALB.
  deployApi: flag('deployApi'),
  allowedOrigins: String(app.node.tryGetContext('allowedOrigins') ?? 'http://localhost:5173').split(','),
  certificateArn: app.node.tryGetContext('certificateArn'),
  alarmEmail: app.node.tryGetContext('alarmEmail'),
  env: process.env.CDK_DEFAULT_ACCOUNT
    ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
    : undefined,
});

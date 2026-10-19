import { App } from 'aws-cdk-lib';
import { UploadPipelineStack, type ApiAuth } from '../lib/upload-pipeline-stack';

const app = new App();
const flag = (name: string) => String(app.node.tryGetContext(name)) === 'true';
const text = (name: string): string | undefined => {
  const v = app.node.tryGetContext(name);
  return v === undefined || v === '' ? undefined : String(v);
};

/** `-c jwtIssuer=... -c jwtAudience=... -c jwtJwksUrl=https://...`, or `-c insecureDemoAuth=true`. */
function apiAuth(): ApiAuth | undefined {
  const issuer = text('jwtIssuer');
  const audience = text('jwtAudience');
  const jwksUrl = text('jwtJwksUrl');
  if (issuer || audience || jwksUrl) {
    if (!issuer || !audience || !jwksUrl) throw new Error('jwtIssuer, jwtAudience and jwtJwksUrl must be given together');
    return { mode: 'jwt', issuer, audience, jwksUrl };
  }
  return flag('insecureDemoAuth') ? { mode: 'header' } : undefined;
}

// `-c stackName=staging` deploys a second, independent copy next to the default one.
new UploadPipelineStack(app, String(app.node.tryGetContext('stackName') ?? 'UploadPipeline'), {
  // `-c local=true` targets LocalStack: no Fargate, disposable resources.
  local: flag('local'),
  // `-c deployApi=true` adds the NestJS API on Fargate behind an ALB.
  deployApi: flag('deployApi'),
  auth: apiAuth(),
  allowedOrigins: String(app.node.tryGetContext('allowedOrigins') ?? 'http://localhost:5173').split(','),
  certificateArn: app.node.tryGetContext('certificateArn'),
  alarmEmail: app.node.tryGetContext('alarmEmail'),
  cognito: flag('cognito') ? { selfSignUp: flag('cognitoSelfSignUp') } : undefined,
  deployWeb: flag('deployWeb'),
  apiDomain: text('apiDomain'),
  apiMaxTasks: text('apiMaxTasks') === undefined ? undefined : Number(text('apiMaxTasks')),
  env: process.env.CDK_DEFAULT_ACCOUNT
    ? { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
    : undefined,
});

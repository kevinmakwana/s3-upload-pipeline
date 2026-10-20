import { randomBytes } from 'node:crypto';
import { AttachRolePolicyCommand, CreateRoleCommand, DeleteRoleCommand, DetachRolePolicyCommand, IAMClient } from '@aws-sdk/client-iam';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export interface Restricted {
  /** Environment variables that make the SDK use the restricted role. */
  env: Record<string, string>;
  /** Detaches and deletes the role. Safe to call twice. */
  cleanup(): Promise<void>;
}

/**
 * The API runs on Fargate with nothing but the stack's ApiPolicy. To prove that policy is enough (the
 * one thing LocalStack cannot check, since it does not enforce IAM), create a throwaway role that has only
 * that policy and trusts the current identity, and assume it.
 */
export async function assumeApiPolicy(policyArn: string): Promise<Restricted> {
  const iam = new IAMClient({});
  const sts = new STSClient({});
  const { Arn: me, Account } = await sts.send(new GetCallerIdentityCommand({}));
  if (!me || !Account) throw new Error('Cannot tell who is calling AWS');
  // An assumed-role ARN cannot be a principal; trust the account and let this identity's own permissions decide.
  const roleName = `s3up-smoke-${randomBytes(4).toString('hex')}`;
  await iam.send(
    new CreateRoleCommand({
      RoleName: roleName,
      Description: 'Temporary: proves the upload API policy is sufficient. Deleted by the smoke test.',
      MaxSessionDuration: 3600,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${Account}:root` }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'aws:PrincipalArn': me.replace(/:assumed-role\/([^/]+)\/.*/, ':role/$1') } } }],
      }),
      Tags: [{ Key: 'purpose', Value: 's3up-smoke-test' }],
    }),
  );
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn })).catch(() => undefined);
    await iam.send(new DeleteRoleCommand({ RoleName: roleName })).catch(() => undefined);
  };
  try {
    await iam.send(new AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: policyArn }));
    const arn = `arn:aws:iam::${Account}:role/${roleName}`;
    // IAM is eventually consistent: a new role can take several seconds to become assumable.
    let lastError: unknown;
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const { Credentials } = await sts.send(new AssumeRoleCommand({ RoleArn: arn, RoleSessionName: 'smoke', DurationSeconds: 3600 }));
        if (!Credentials?.AccessKeyId) throw new Error('No credentials returned');
        return {
          env: { AWS_ACCESS_KEY_ID: Credentials.AccessKeyId, AWS_SECRET_ACCESS_KEY: Credentials.SecretAccessKey!, AWS_SESSION_TOKEN: Credentials.SessionToken! },
          cleanup,
        };
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 2_500));
      }
    }
    throw lastError;
  } catch (err) {
    await cleanup();
    throw err;
  }
}

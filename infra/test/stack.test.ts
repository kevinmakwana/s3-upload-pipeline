import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UploadPipelineStack } from '../lib/upload-pipeline-stack';

function synth(props: Partial<ConstructorParameters<typeof UploadPipelineStack>[2]> = {}) {
  // Skip esbuild bundling: these tests assert on the template, not the asset.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new UploadPipelineStack(app, 'Test', {
    local: false,
    deployApi: false,
    allowedOrigins: ['https://app.example.com'],
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

/** Every logical id a template value points at (Ref, GetAtt, Sub, DependsOn). */
function references(value: unknown, ids: Set<string>, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => references(v, ids, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'Ref' && typeof v === 'string' && ids.has(v)) out.add(v);
      else if (k === 'Fn::GetAtt') {
        const id = Array.isArray(v) ? v[0] : String(v).split('.')[0];
        if (ids.has(id)) out.add(id);
      } else if (k === 'Fn::Sub') {
        const text = Array.isArray(v) ? v[0] : v;
        for (const m of String(text).matchAll(/\$\{([A-Za-z0-9]+)(?:\.[^}]*)?\}/g)) if (ids.has(m[1]!)) out.add(m[1]!);
        if (Array.isArray(v)) references(v[1], ids, out);
      } else references(v, ids, out);
    }
  }
  return out;
}

/** CloudFormation rejects dependency cycles only at deploy time, so catch them here. */
function findCycle(template: { Resources: Record<string, Record<string, unknown>> }): string[] | undefined {
  const ids = new Set(Object.keys(template.Resources));
  const edges = new Map<string, string[]>();
  for (const [id, res] of Object.entries(template.Resources)) {
    const deps = references({ ...res, DependsOn: undefined }, ids);
    for (const d of ([] as string[]).concat((res.DependsOn as string | string[] | undefined) ?? [])) deps.add(d);
    deps.delete(id);
    edges.set(id, [...deps]);
  }
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 2) return undefined;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of edges.get(id) ?? []) {
      const cycle = visit(d);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of ids) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

describe('UploadPipelineStack', () => {
  const t = synth();

  it.each([
    ['AWS', {}],
    ['AWS with the API', { deployApi: true }],
    ['LocalStack', { local: true }],
  ])('has no resource dependency cycle (%s)', (_name, props) => {
    const template = synth(props as never).toJSON();
    expect(findCycle(template as never)).toBeUndefined();
  });

  it('detects a cycle when there is one (guards the guard)', () => {
    expect(findCycle({ Resources: { A: { Properties: { x: { Ref: 'B' } } }, B: { DependsOn: ['A'] } } })).toEqual(['A', 'B', 'A']);
  });

  it('derives the bucket name from the stack id so copies do not collide, and rejects ids that cannot be bucket names', () => {
    const name = (id: string) => {
      const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
      const stack = new UploadPipelineStack(app, id, { local: false, deployApi: false, allowedOrigins: ['https://a.example'], env: { account: '123456789012', region: 'us-east-1' } });
      return JSON.stringify(Template.fromStack(stack).findResources('AWS::S3::Bucket'));
    };
    expect(name('Staging')).toContain('staging-uploads-');
    expect(name('Prod')).toContain('prod-uploads-');
    expect(() => name('Under_Score')).toThrow(); // CDK itself rejects it first
    expect(() => name('x'.repeat(27))).toThrow(/bucket name/);
  });

  it('sets AWS_REGION explicitly on the API container', () => {
    synth({ deployApi: true }).hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [Match.objectLike({ Environment: Match.arrayWith([Match.objectLike({ Name: 'AWS_REGION' })]) })],
    });
  });

  it('wires S3 notifications without a helper Lambda, which LocalStack cannot run', () => {
    expect(Object.keys(t.findResources('Custom::S3BucketNotifications'))).toEqual([]);
    const bucket = Object.values(t.findResources('AWS::S3::Bucket'))[0] as { DependsOn?: string[]; Properties: { BucketName: unknown } };
    expect(bucket.DependsOn?.some((d) => d.startsWith('ProcessingQueuePolicy'))).toBe(true);
    // A fixed (pseudo-parameter based) name is what breaks the bucket <-> queue-policy cycle.
    expect(JSON.stringify(bucket.Properties.BucketName)).not.toContain('"Ref":"UploadBucket');
  });

  it('blocks all public access, enforces TLS and encrypts the bucket', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: Match.objectLike({ ServerSideEncryptionConfiguration: Match.anyValue() }),
      VersioningConfiguration: { Status: 'Enabled' },
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]),
      }),
    });
  });

  it('aborts incomplete multipart uploads via a lifecycle rule', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Id: 'abort-incomplete-multipart-uploads', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 }, Status: 'Enabled' }),
        ]),
      },
    });
  });

  it('restricts CORS to the configured origins and exposes ETag', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://app.example.com'], ExposedHeaders: Match.arrayWith(['ETag']) })] },
    });
  });

  it('sends uploads/ ObjectCreated events to the queue, and only S3 from this bucket may enqueue', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      NotificationConfiguration: {
        QueueConfigurations: [
          Match.objectLike({ Event: 's3:ObjectCreated:*', Filter: { S3Key: { Rules: [{ Name: 'prefix', Value: 'uploads/' }] } } }),
        ],
      },
    });
    t.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowS3ToEnqueue',
            Principal: { Service: 's3.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Condition: Match.objectLike({ ArnEquals: Match.anyValue(), StringEquals: Match.anyValue() }),
          }),
        ]),
      }),
    });
  });

  it('dead-letters after 3 receives and gives the visibility timeout headroom over the Lambda timeout', () => {
    t.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
      VisibilityTimeout: 900 * 6,
    });
  });

  it('wires the worker to SQS with partial batch responses', () => {
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 5 },
    });
    t.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Timeout: 900 });
  });

  it('alarms on the DLQ and notifies SNS', () => {
    t.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      AlarmActions: [Match.anyValue()],
    });
  });

  it('keeps file records in an on-demand table with TTL and a by-user index', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'byUser' })],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('retains data on delete in AWS', () => {
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  describe('least privilege', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy', {})).concat(Object.values(t.findResources('AWS::IAM::ManagedPolicy', {})));
    const statements = policies.flatMap((p) => {
      const doc = (p as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } }).Properties.PolicyDocument;
      return doc.Statement;
    });
    const actionsOf = (s: Record<string, unknown>) => [s.Action].flat() as string[];

    it('never grants wildcard actions or resources to IAM principals we define', () => {
      for (const s of statements) {
        if (s.Effect !== 'Allow') continue;
        for (const a of actionsOf(s)) expect(a).not.toMatch(/\*$/);
        // Log delivery and SQS consume permissions are generated by CDK against specific ARNs.
        expect(JSON.stringify(s.Resource)).not.toBe('"*"');
      }
    });

    it('scopes object access to the uploads/ and thumbnails/ prefixes', () => {
      // Object-level actions only; CDK's own notification handler needs bucket-level PutBucketNotification.
      const s3Statements = statements.filter((s) => actionsOf(s).some((a) => /^s3:(Get|Put|Delete|Abort|ListMultipart)/.test(a) && !/Bucket/.test(a)));
      expect(s3Statements.length).toBeGreaterThan(0);
      for (const s of s3Statements) expect(JSON.stringify(s.Resource)).toMatch(/uploads\/\*|thumbnails\/\*/);
    });

    it('limits the worker to reading uploads, writing thumbnails and two DynamoDB actions', () => {
      const flat = JSON.stringify(statements);
      expect(flat).toContain('dynamodb:GetItem');
      const workerDynamo = statements.find((s) => s.Sid === 'FileRecordsAndLedger')!;
      expect(actionsOf(workerDynamo).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
      const writes = statements.find((s) => s.Sid === 'WriteThumbnails')!;
      expect(JSON.stringify(writes.Resource)).toContain('thumbnails/*');
    });
  });

  it('adds Fargate + ALB only when asked, and disposable resources for LocalStack', () => {
    expect(t.findResources('AWS::ECS::Service')).toEqual({});
    const withApi = synth({ deployApi: true });
    withApi.resourceCountIs('AWS::ECS::Service', 1);
    withApi.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', { HealthCheckPath: '/health' });
    withApi.hasResourceProperties('AWS::ECS::TaskDefinition', { RuntimePlatform: { CpuArchitecture: 'X86_64', OperatingSystemFamily: 'LINUX' } });

    const local = synth({ local: true });
    local.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    local.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ S3_FORCE_PATH_STYLE: 'true' }) } });
  });
});

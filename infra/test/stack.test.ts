import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { METRICS_NAMESPACE } from '../../functions/src/process-upload/metrics';
import { UploadPipelineStack, WORKER_METRICS_NAMESPACE } from '../lib/upload-pipeline-stack';
import { contentSecurityPolicy, webRuntimeConfig } from '../lib/web-hosting';

const JWT_AUTH = { mode: 'jwt', issuer: 'https://idp.example.com/', audience: 'upload-api', jwksUrl: 'https://idp.example.com/.well-known/jwks.json' } as const;

/** An IAM policy statement as it appears in a synthesized template (the shape varies, so it is read loosely). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Statement = Record<string, any>;

function synth(props: Partial<ConstructorParameters<typeof UploadPipelineStack>[2]> = {}) {
  // Skip esbuild bundling: these tests assert on the template, not the asset.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new UploadPipelineStack(app, 'Test', {
    local: false,
    deployApi: false,
    allowedOrigins: ['https://app.example.com'],
    // The API refuses to deploy without an auth choice; most tests just need a valid one.
    ...(props.deployApi && !('auth' in props) ? { auth: JWT_AUTH } : {}),
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return Template.fromStack(stack);
}

/** Environment variables of the API container, as a name -> value map. */
function apiEnvironment(template: Template): Record<string, unknown> {
  const [task] = Object.values(template.findResources('AWS::ECS::TaskDefinition'));
  const env = (task!.Properties.ContainerDefinitions[0].Environment ?? []) as { Name: string; Value: unknown }[];
  return Object.fromEntries(env.map((e) => [e.Name, e.Value]));
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

const XRAY_WRITES = ['xray:PutTelemetryRecords', 'xray:PutTraceSegments'];
/** CDK grants a stream reader ListStreams on "*". It lists stream ARNs and reads no data; the reads are scoped to this table's stream. */
const LIST_STREAMS = ['dynamodb:ListStreams'];

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
      const stack = new UploadPipelineStack(app, id, {
        local: false,
        deployApi: false,
        allowedOrigins: ['https://a.example'],
        env: { account: '123456789012', region: 'us-east-1' },
      });
      return JSON.stringify(Template.fromStack(stack).findResources('AWS::S3::Bucket'));
    };
    expect(name('Staging')).toContain('staging-uploads-');
    expect(name('Prod')).toContain('prod-uploads-');
    expect(() => name('Under_Score')).toThrow(); // CDK itself rejects it first
    expect(() => name('x'.repeat(27))).toThrow(/bucket name/);
  });

  describe('API authentication', () => {
    it('passes the JWT settings to the API container (it refuses to start in production without them)', () => {
      const env = apiEnvironment(synth({ deployApi: true }));
      expect(env).toMatchObject({
        AUTH_MODE: 'jwt',
        JWT_ISSUER: JWT_AUTH.issuer,
        JWT_AUDIENCE: JWT_AUTH.audience,
        JWT_JWKS_URL: JWT_AUTH.jwksUrl,
      });
      expect(env).not.toHaveProperty('ALLOW_INSECURE_DEMO_AUTH');
    });

    it('trusts exactly one proxy (the load balancer), so rate limits see real client addresses', () => {
      expect(apiEnvironment(synth({ deployApi: true }))).toMatchObject({ TRUST_PROXY_HOPS: '1' });
    });

    it('refuses to deploy the API with no auth choice', () => {
      expect(() => synth({ deployApi: true, auth: undefined })).toThrow(/auth/i);
    });

    it('requires an https JWKS URL', () => {
      expect(() => synth({ deployApi: true, auth: { ...JWT_AUTH, jwksUrl: 'http://idp.example.com/jwks.json' } })).toThrow(/https/);
    });

    it('lets you opt in to the insecure demo auth explicitly, and says so in the environment', () => {
      const env = apiEnvironment(synth({ deployApi: true, auth: { mode: 'header' } }));
      expect(env).toMatchObject({ AUTH_MODE: 'header', ALLOW_INSECURE_DEMO_AUTH: 'true' });
      expect(env).not.toHaveProperty('JWT_ISSUER');
    });

    it('needs no auth when the API is not deployed', () => {
      expect(() => synth()).not.toThrow();
    });
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
        QueueConfigurations: [Match.objectLike({ Event: 's3:ObjectCreated:*', Filter: { S3Key: { Rules: [{ Name: 'prefix', Value: 'uploads/' }] } } })],
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

  describe('worker observability', () => {
    it('traces every invocation of the worker', () => {
      t.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Timeout: 900, TracingConfig: { Mode: 'Active' } });
    });

    it('reads the metrics namespace the worker publishes to (kept equal to the worker code)', () => {
      expect(WORKER_METRICS_NAMESPACE).toBe(METRICS_NAMESPACE);
    });

    it('warns when one object uses 80% of the time limit, because a run that hits the limit is killed before it can report', () => {
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: METRICS_NAMESPACE,
        MetricName: 'ProcessingMs',
        Statistic: 'Maximum',
        Threshold: 720_000,
        EvaluationPeriods: 1,
        TreatMissingData: 'notBreaching',
        AlarmActions: [Match.anyValue()],
      });
    });

    it('has a dashboard of what the worker handled, how long it took, the queue wait, errors and the dead-letter queue', () => {
      const [dashboard] = Object.values(t.findResources('AWS::CloudWatch::Dashboard'));
      const body = JSON.stringify(dashboard!.Properties.DashboardBody);
      for (const name of ['ObjectsHandled', 'ProcessingMs', 'QueueLatencyMs', 'BytesProcessed', 'Errors', 'Throttles', 'ApproximateNumberOfMessagesVisible']) {
        expect(body).toContain(name);
      }
      for (const outcome of ['processed', 'rejected', 'duplicate', 'error']) expect(body).toContain(outcome);
    });
  });

  describe('live file updates (change notifications)', () => {
    const policyStatements = (template: Template) =>
      Object.values(template.findResources('AWS::IAM::ManagedPolicy', {}))
        .concat(Object.values(template.findResources('AWS::IAM::Policy', {})))
        .flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement);
    const sid = (template: Template, name: string) => policyStatements(template).find((s) => s.Sid === name)!;

    it('streams every change to a file record, old and new, so a deleted file still names its owner', () => {
      t.hasResourceProperties('AWS::DynamoDB::Table', { StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' } });
    });

    it('forwards stream records from now on, in small waits, skipping the processing ledger and anything stale', () => {
      t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        StartingPosition: 'LATEST',
        BatchSize: 100,
        MaximumBatchingWindowInSeconds: 1,
        BisectBatchOnFunctionError: true,
        MaximumRetryAttempts: 2,
        MaximumRecordAgeInSeconds: 120,
        FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { Keys: { pk: { S: [{ prefix: 'FILE#' }] } } } }) }] },
      });
    });

    it('lets the forwarder publish to the changes topic and nothing else on SNS', () => {
      // Role policies only: the API's permissions (a managed policy) are checked separately below.
      const roleStatements = Object.values(t.findResources('AWS::IAM::Policy', {})).flatMap(
        (p) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement,
      );
      const sns = roleStatements.filter((s) => [s.Action].flat().some((a) => String(a).startsWith('sns:')));
      expect(sns.length).toBeGreaterThan(0);
      for (const s of sns) expect([s.Action].flat().sort()).toEqual(['sns:Publish']);
    });

    it('makes the topic refuse unencrypted connections, and traces and alarms on the forwarder', () => {
      t.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
      });
      t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: { TOPIC_ARN: Match.anyValue() } }, TracingConfig: { Mode: 'Active' } });
      t.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Errors',
        Threshold: 3,
        AlarmActions: [Match.anyValue()],
        Dimensions: [{ Name: 'FunctionName', Value: Match.anyValue() }],
      });
    });

    it('tells the API where the topic is and what to call its queues, only when the API is deployed', () => {
      const env = apiEnvironment(synth({ deployApi: true }));
      expect(env.CHANGES_TOPIC_ARN).toBeDefined();
      expect(String(env.CHANGES_QUEUE_PREFIX)).toMatch(/^[\w-]{1,60}$/);
      t.hasOutput('ChangesTopicArn', Match.anyValue());
      t.hasOutput('ChangesQueuePrefix', Match.anyValue());
    });

    it("gives the API's tasks their own queues under the prefix, one subscription each, and no way into anyone else's", () => {
      const withApi = synth({ deployApi: true });
      const queues = sid(withApi, 'ChangeFeedQueues');
      expect([queues.Action].flat().sort()).toEqual([
        'sqs:CreateQueue',
        'sqs:DeleteMessage',
        'sqs:DeleteQueue',
        'sqs:GetQueueUrl',
        'sqs:ReceiveMessage',
        'sqs:SetQueueAttributes',
      ]);
      expect(JSON.stringify(queues.Resource)).toMatch(/:sqs:.*-sse-\*/);
      expect(JSON.stringify(queues.Resource)).not.toBe('"*"');

      expect([sid(withApi, 'ChangeFeedSubscribe').Action].flat().sort()).toEqual(['sns:ListSubscriptionsByTopic', 'sns:Subscribe']);
      const unsubscribe = sid(withApi, 'ChangeFeedUnsubscribe');
      expect([unsubscribe.Action].flat()).toEqual(['sns:Unsubscribe']);
      expect(JSON.stringify(unsubscribe.Resource)).toContain(':*'); // a subscription ARN: the topic's plus an id
    });

    it('names queues in the policy exactly as the API is told to name them', () => {
      const withApi = synth({ deployApi: true });
      const prefix = String(apiEnvironment(withApi).CHANGES_QUEUE_PREFIX);
      expect(JSON.stringify(sid(withApi, 'ChangeFeedQueues').Resource)).toContain(`${prefix}-*`);
    });
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
        // Log delivery and SQS consume permissions are generated by CDK against specific ARNs. X-Ray's write actions
        // are an exception: AWS does not support resource-level permissions for them, so "*" is the only form.
        if (actionsOf(s).every((a) => XRAY_WRITES.includes(a)) || actionsOf(s).every((a) => LIST_STREAMS.includes(a))) continue;
        expect(JSON.stringify(s.Resource)).not.toBe('"*"');
      }
    });

    it('lets the traced functions send trace data to X-Ray, and nothing else on X-Ray', () => {
      const xray = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('xray:')));
      expect(xray.length).toBeGreaterThan(0);
      for (const s of xray) expect(actionsOf(s).sort()).toEqual(XRAY_WRITES);
    });

    it('scopes object access to the uploads/ and thumbnails/ prefixes', () => {
      // Object-level actions only; CDK's own notification handler needs bucket-level PutBucketNotification.
      const s3Statements = statements.filter((s) => actionsOf(s).some((a) => /^s3:(Get|Put|Delete|Abort|ListMultipart)/.test(a) && !/Bucket/.test(a)));
      expect(s3Statements.length).toBeGreaterThan(0);
      for (const s of s3Statements) expect(JSON.stringify(s.Resource)).toMatch(/uploads\/\*|thumbnails\/\*/);
    });

    it('lets the API download a stored version and delete a finished file, and no more', () => {
      const sid = (name: string) => statements.find((s) => s.Sid === name)!;
      const resourceText = (name: string) => JSON.stringify(sid(name).Resource);

      // Download is pinned to the verified version; deleting removes every version of the object.
      expect(actionsOf(sid('VerifyAndDiscardObjects')).sort()).toEqual(['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:GetObject', 's3:GetObjectVersion']);
      expect(resourceText('VerifyAndDiscardObjects')).toContain('uploads/*');
      expect(resourceText('VerifyAndDiscardObjects')).not.toContain('thumbnails');

      // Thumbnails are deleted along with their file, and only deleted.
      expect(actionsOf(sid('DiscardThumbnails')).sort()).toEqual(['s3:DeleteObject', 's3:DeleteObjectVersion']);
      expect(resourceText('DiscardThumbnails')).toContain('thumbnails/*');

      // Listing versions is a bucket-level action, so it is limited to the two prefixes by condition.
      const list = sid('ListObjectVersions');
      expect(actionsOf(list)).toEqual(['s3:ListBucketVersions']);
      expect(list.Condition).toEqual({ StringLike: { 's3:prefix': ['uploads/*', 'thumbnails/*'] } });
      expect(JSON.stringify(list.Resource)).not.toContain('/*');

      expect(actionsOf(sid('FileRecords')).sort()).toEqual([
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
      ]);
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

  describe('Cognito sign-in', () => {
    const cognito = { selfSignUp: false };

    it('creates a pool with a hosted login and one public client that can only use the authorization code flow', () => {
      const t = synth({ cognito });
      t.resourceCountIs('AWS::Cognito::UserPool', 1);
      t.hasResourceProperties('AWS::Cognito::UserPool', {
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        DeletionProtection: 'ACTIVE',
        Policies: { PasswordPolicy: Match.objectLike({ MinimumLength: 12 }) },
      });
      t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
        GenerateSecret: false,
        AllowedOAuthFlows: ['code'],
        AllowedOAuthFlowsUserPoolClient: true,
        AllowedOAuthScopes: ['openid', 'email'],
        CallbackURLs: ['https://app.example.com/'],
        LogoutURLs: ['https://app.example.com/'],
        PreventUserExistenceErrors: 'ENABLED',
        EnableTokenRevocation: true,
      });
      t.hasResourceProperties('AWS::Cognito::UserPoolDomain', { Domain: { 'Fn::Join': ['', ['test-', { Ref: 'AWS::AccountId' }]] } });
    });

    it('only lets people sign themselves up when asked to', () => {
      synth({ cognito: { selfSignUp: true } }).hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: { AllowAdminCreateUserOnly: false } });
    });

    it('points the API at the pool: issuer, client id as audience, and the pool JWKS', () => {
      const t = synth({ deployApi: true, cognito, auth: undefined });
      const env = apiEnvironment(t);
      expect(env.AUTH_MODE).toBe('jwt');
      expect(JSON.stringify(env.JWT_ISSUER)).toContain('AuthPool');
      expect(JSON.stringify(env.JWT_ISSUER)).toContain('https://');
      expect(JSON.stringify(env.JWT_AUDIENCE)).toContain('AuthPoolWebClient');
      expect(JSON.stringify(env.JWT_JWKS_URL)).toContain('/.well-known/jwks.json');
      expect(env.ALLOW_INSECURE_DEMO_AUTH).toBeUndefined();
    });

    it('is not combined with an auth choice of your own, and does not exist in LocalStack', () => {
      expect(() => synth({ deployApi: true, cognito, auth: JWT_AUTH })).toThrow(/Choose one/);
      expect(() => synth({ local: true, cognito })).toThrow(/LocalStack/);
    });

    it('rejects stack ids Cognito would refuse in its domain', () => {
      const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
      expect(() => new UploadPipelineStack(app, 'MyCognitoApp', { local: false, deployApi: false, allowedOrigins: [], cognito })).toThrow(/does not allow/);
    });

    it('creates nothing when not asked', () => {
      t.resourceCountIs('AWS::Cognito::UserPool', 0);
    });
  });

  describe('web hosting', () => {
    const web = { deployWeb: true, apiDomain: 'api.example.com', webDistPath: path.join(__dirname, 'fixtures', 'web-dist') };

    it('serves a private bucket through CloudFront over HTTPS only, with single-page-app fallbacks', () => {
      const t = synth(web);
      t.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }) });
      t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
      t.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: Match.objectLike({
          DefaultRootObject: 'index.html',
          DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
          CustomErrorResponses: [
            Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
            Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          ],
        }),
      });
    });

    it('never caches the shell or the config, so a new deployment shows at once', () => {
      const t = synth(web);
      const [dist] = Object.values(t.findResources('AWS::CloudFront::Distribution'));
      const behaviors = dist!.Properties.DistributionConfig.CacheBehaviors as { PathPattern: string; CachePolicyId: string }[];
      expect(behaviors.map((b) => b.PathPattern).sort()).toEqual(['/config.json', '/index.html']);
      // The managed CachingDisabled policy.
      for (const b of behaviors) expect(b.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
    });

    it('sends security headers, including a policy that allows only our API, S3 and Cognito', () => {
      const t = synth(web);
      t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
        ResponseHeadersPolicyConfig: Match.objectLike({
          SecurityHeadersConfig: Match.objectLike({
            StrictTransportSecurity: Match.objectLike({ IncludeSubdomains: true }),
            FrameOptions: { FrameOption: 'DENY', Override: true },
            ContentTypeOptions: { Override: true },
          }),
        }),
      });
      const policy = contentSecurityPolicy('api.example.com');
      expect(policy).toContain("default-src 'none'");
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("connect-src 'self' https://api.example.com https://*.amazonaws.com https://*.amazoncognito.com");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toContain('unsafe-eval');
      expect(policy).not.toMatch(/script-src[^;]*unsafe-inline/);
    });

    it('lets the hosted page call the API and put parts to S3 (CORS), without listing it by hand', () => {
      const t = synth({ ...web, deployApi: true, certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' });
      const origins = t.findResources('AWS::S3::Bucket') as Record<
        string,
        { Properties: { CorsConfiguration?: { CorsRules: { AllowedOrigins: unknown[] }[] } } }
      >;
      const upload = Object.values(origins).find((b) => b.Properties.CorsConfiguration)!;
      const allowed = JSON.stringify(upload.Properties.CorsConfiguration!.CorsRules[0]!.AllowedOrigins);
      expect(allowed).toContain('https://app.example.com');
      expect(allowed).toContain('Distribution');
      expect(JSON.stringify(apiEnvironment(t).CORS_ORIGINS)).toContain('Distribution');
    });

    it('deploys the app, replacing what was there, and refreshes the CDN', () => {
      const t = synth(web);
      t.resourceCountIs('Custom::CDKBucketDeployment', 1);
      t.hasResourceProperties('Custom::CDKBucketDeployment', { Prune: true, DistributionPaths: ['/*'] });
    });

    it('writes a config.json that says where the API is and how to sign in', () => {
      expect(webRuntimeConfig('api.example.com')).toEqual({ apiUrl: 'https://api.example.com', auth: { mode: 'demo' } });
      expect(webRuntimeConfig('api.example.com', { url: 'https://login.example.com', clientId: 'c1' })).toEqual({
        apiUrl: 'https://api.example.com',
        auth: {
          mode: 'oidc',
          authorizeUrl: 'https://login.example.com/oauth2/authorize',
          tokenUrl: 'https://login.example.com/oauth2/token',
          logoutUrl: 'https://login.example.com/logout',
          clientId: 'c1',
          scope: 'openid email',
        },
      });
    });

    it('fills the real login address and client id into config.json when Cognito is on', () => {
      const t = synth({ ...web, cognito: { selfSignUp: false } });
      const [deployment] = Object.values(t.findResources('Custom::CDKBucketDeployment'));
      const markers = JSON.stringify(deployment!.Properties.SourceMarkers);
      expect(markers).toContain('/oauth2/authorize');
      expect(markers).toContain('/oauth2/token');
      expect(markers).toContain('/logout');
      expect(markers).toContain('AuthPoolWebClient');
    });

    it('allows the hosted page to complete a Cognito sign-in', () => {
      const t = synth({ ...web, cognito: { selfSignUp: false } });
      const [client] = Object.values(t.findResources('AWS::Cognito::UserPoolClient'));
      expect(JSON.stringify(client!.Properties.CallbackURLs)).toContain('Distribution');
    });

    it('needs an API host name, and an HTTPS certificate when it also deploys the API', () => {
      expect(() => synth({ deployWeb: true, webDistPath: web.webDistPath })).toThrow(/apiDomain/);
      expect(() => synth({ ...web, deployApi: true })).toThrow(/certificateArn/);
      expect(() => synth({ ...web, apiDomain: 'https://api.example.com' })).toThrow(/bare host name/);
    });

    it('is not available in LocalStack, and adds nothing when not asked', () => {
      expect(() => synth({ ...web, local: true })).toThrow(/LocalStack/);
      t.resourceCountIs('AWS::CloudFront::Distribution', 0);
    });
  });

  describe('malware scanning', () => {
    const scanned = () => synth({ malwareScan: true, deployApi: true });
    const policyStatements = (t: Template) =>
      [...Object.values(t.findResources('AWS::IAM::Policy')), ...Object.values(t.findResources('AWS::IAM::ManagedPolicy'))].flatMap(
        (p) => (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties.PolicyDocument.Statement,
      );

    const BUCKET = { 'Fn::Join': ['', ['test-uploads-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]] };

    it('is off by default: no scan plan, no rule, no handler', () => {
      t.resourceCountIs('AWS::GuardDuty::MalwareProtectionPlan', 0);
      t.resourceCountIs('AWS::Events::Rule', 0);
      expect(JSON.stringify(apiEnvironment(synth({ deployApi: true })))).not.toContain('MALWARE_SCAN');
    });

    it('is not available in LocalStack', () => {
      expect(() => synth({ local: true, malwareScan: true })).toThrow(/LocalStack/);
    });

    it('scans only what users upload, and tags each object with the verdict', () => {
      scanned().hasResourceProperties('AWS::GuardDuty::MalwareProtectionPlan', {
        ProtectedResource: { S3Bucket: { BucketName: BUCKET, ObjectPrefixes: ['uploads/'] } },
        Actions: { Tagging: { Status: 'ENABLED' } },
      });
    });

    it('lets GuardDuty, and only GuardDuty, assume a role limited to this bucket', () => {
      const t = scanned();
      const [role] = Object.values(t.findResources('AWS::IAM::Role')).filter((r) =>
        JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('malware-protection-plan.guardduty.amazonaws.com'),
      );
      expect(role).toBeDefined();
      const trust = role!.Properties.AssumeRolePolicyDocument.Statement as { Principal: { Service: string } }[];
      expect(trust.map((s) => s.Principal.Service)).toEqual(['malware-protection-plan.guardduty.amazonaws.com']);

      const granted = Object.values(t.findResources('AWS::IAM::Policy'))
        .filter((p) => JSON.stringify(p.Properties.Roles).includes('ScanRole'))
        .flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
      expect(granted.length).toBeGreaterThan(0);
      const actions = new Set(granted.flatMap((s) => [s.Action].flat() as string[]));
      for (const a of [
        's3:GetObject',
        's3:GetObjectVersion',
        's3:PutObjectTagging',
        's3:PutObjectVersionTagging',
        's3:GetObjectTagging',
        's3:GetObjectVersionTagging',
      ]) {
        expect(actions).toContain(a);
      }
      // It scans and tags. It must not be able to write or delete the data itself.
      for (const a of ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:GetBucketAcl']) expect(actions).not.toContain(a);
    });

    it('turns on S3 -> EventBridge delivery next to the queue notification, so GuardDuty can see uploads', () => {
      scanned().hasResourceProperties('AWS::S3::Bucket', {
        NotificationConfiguration: Match.objectLike({ EventBridgeConfiguration: { EventBridgeEnabled: true }, QueueConfigurations: Match.anyValue() }),
      });
    });

    it("sends this bucket's scan results to a handler, with retries and a dead-letter queue that alarms", () => {
      const t = scanned();
      t.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['aws.guardduty'],
          'detail-type': ['GuardDuty Malware Protection Object Scan Result'],
          detail: { s3ObjectDetails: { bucketName: [BUCKET] } },
        },
        Targets: Match.arrayWith([
          Match.objectLike({ DeadLetterConfig: Match.anyValue(), RetryPolicy: Match.objectLike({ MaximumRetryAttempts: Match.anyValue() }) }),
        ]),
      });
      const alarms = Object.values(t.findResources('AWS::CloudWatch::Alarm')).map((a) => JSON.stringify(a.Properties));
      expect(alarms.some((a) => a.includes('ScanResultDlq'))).toBe(true);
      expect(alarms.some((a) => a.includes('ScanResultFn'))).toBe(true);
    });

    it('tells the alarm topic whenever malware is found', () => {
      const t = scanned();
      const rules = Object.values(t.findResources('AWS::Events::Rule')).map((r) => r.Properties);
      const threat = rules.find((r) => JSON.stringify(r.EventPattern).includes('THREATS_FOUND'));
      expect(threat).toBeDefined();
      expect(JSON.stringify(threat!.Targets)).toContain('AlarmTopic');
    });

    it('gives the handler exactly what it needs: read and update the record, delete stored versions', () => {
      const t = scanned();
      t.hasResourceProperties('AWS::Lambda::Function', {
        Environment: { Variables: Match.objectLike({ TABLE_NAME: Match.anyValue(), BUCKET_NAME: Match.anyValue() }) },
        Timeout: 120,
      });
      const statements = policyStatements(t);
      const handler = statements.filter((s) => String(s.Sid ?? '').startsWith('ScanResult'));
      const bySid = (sid: string) => handler.find((s) => s.Sid === sid)!;
      expect([bySid('ScanResultRecords').Action].flat().sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
      expect([bySid('ScanResultDeleteVersions').Action].flat().sort()).toEqual(['s3:DeleteObjectVersion']);
      expect(JSON.stringify(bySid('ScanResultDeleteVersions').Resource)).toMatch(/uploads\/\*.*thumbnails\/\*|thumbnails\/\*.*uploads\/\*/);
      expect([bySid('ScanResultListVersions').Action].flat()).toEqual(['s3:ListBucketVersions']);
      expect(bySid('ScanResultListVersions').Condition).toEqual({ StringLike: { 's3:prefix': ['uploads/*', 'thumbnails/*'] } });
    });

    it('switches the API to scan-aware downloads and lets it read verdict tags on uploads only', () => {
      const t = scanned();
      expect(apiEnvironment(t).MALWARE_SCAN).toBe('true');
      const read = policyStatements(t).find((s) => s.Sid === 'ReadScanVerdicts')!;
      expect([read.Action].flat().sort()).toEqual(['s3:GetObjectTagging', 's3:GetObjectVersionTagging']);
      expect(JSON.stringify(read.Resource)).toContain('uploads/*');
      expect(JSON.stringify(read.Resource)).not.toContain('thumbnails');
    });
  });

  describe('API monitoring and scaling', () => {
    it('has no API alarms or scaling when the API is not deployed', () => {
      t.resourceCountIs('AWS::CloudWatch::Alarm', 5); // DLQ, backlog, worker errors, slow object, file changes
      t.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 0);
    });

    it('alarms on server errors, unhealthy targets, slow responses, CPU and memory, and notifies the alarm topic', () => {
      const withApi = synth({ deployApi: true });
      const alarms = Object.values(withApi.findResources('AWS::CloudWatch::Alarm')).map((a) => a.Properties);
      const byMetric = (name: string) => alarms.filter((a) => a.MetricName === name || JSON.stringify(a.Metrics ?? '').includes(name));
      for (const metric of [
        'HTTPCode_Target_5XX_Count',
        'HTTPCode_ELB_5XX_Count',
        'UnHealthyHostCount',
        'TargetResponseTime',
        'CPUUtilization',
        'MemoryUtilization',
      ]) {
        expect({ metric, alarms: byMetric(metric).length }).toEqual({ metric, alarms: 1 });
      }
      withApi.resourceCountIs('AWS::CloudWatch::Alarm', 5 + 6);
      for (const alarm of alarms) expect(alarm.AlarmActions).toHaveLength(1);
      // Quiet periods are not outages: missing data must not page anyone.
      for (const alarm of alarms) expect(alarm.TreatMissingData).toBe('notBreaching');
    });

    it('scales the service between one and four tasks on CPU, and on requests per task', () => {
      const withApi = synth({ deployApi: true });
      withApi.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 1, MaxCapacity: 4 });
      const policies = Object.values(withApi.findResources('AWS::ApplicationAutoScaling::ScalingPolicy')).map((p) => p.Properties);
      const types = policies.map((p) => p.TargetTrackingScalingPolicyConfiguration.PredefinedMetricSpecification.PredefinedMetricType).sort();
      expect(types).toEqual(['ALBRequestCountPerTarget', 'ECSServiceAverageCPUUtilization']);
    });

    it('lets the ceiling be changed, and refuses one below the floor', () => {
      synth({ deployApi: true, apiMaxTasks: 10 }).hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MaxCapacity: 10 });
      expect(() => synth({ deployApi: true, apiMaxTasks: 0 })).toThrow(/apiMaxTasks/);
      expect(() => synth({ deployApi: true, apiMaxTasks: 2.5 })).toThrow(/apiMaxTasks/);
    });

    it('does not pin a task count, so a deploy does not undo what autoscaling decided', () => {
      const withApi = synth({ deployApi: true });
      const [service] = Object.values(withApi.findResources('AWS::ECS::Service'));
      expect(service!.Properties.DesiredCount).toBeUndefined();
    });
  });
});

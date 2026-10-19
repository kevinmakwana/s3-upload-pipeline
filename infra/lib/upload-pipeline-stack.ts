import * as path from 'node:path';
import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * How the API authenticates callers. `jwt` verifies bearer tokens from your identity provider.
 * `header` trusts any x-user-id: demo only, and must be chosen on purpose.
 */
export type ApiAuth =
  | { mode: 'jwt'; issuer: string; audience: string; jwksUrl: string }
  | { mode: 'header' };

export interface UploadPipelineProps extends StackProps {
  /** Target LocalStack: disposable resources, no ECS/ALB. */
  local: boolean;
  /** Also deploy the API on Fargate behind an ALB. */
  deployApi: boolean;
  /** Origins allowed to PUT parts / GET thumbnails from the browser, and to call the API. */
  allowedOrigins: string[];
  /** Required when `deployApi` is on: the API container fails closed without an auth choice. */
  auth?: ApiAuth;
  /** ACM certificate for the ALB's HTTPS listener (recommended; the browser UI is usually HTTPS). */
  certificateArn?: string;
  /** Subscribe this address to the alarm topic. */
  alarmEmail?: string;
  /** Most API tasks autoscaling may run (default 4). The least is one. */
  apiMaxTasks?: number;
}

/** Longest the worker may run. Checksumming a 15 GB object streams at roughly 100-300 MB/s. */
const WORKER_TIMEOUT = Duration.minutes(15);
const MAX_RECEIVE_COUNT = 3;
const repoRoot = path.resolve(__dirname, '..', '..');

export class UploadPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: UploadPipelineProps) {
    super(scope, id, props);
    const { local } = props;
    const removal = local ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    // ---------------------------------------------------------------- storage
    // A fixed name lets the queue policy reference the bucket without a circular dependency,
    // which in turn lets us configure notifications natively instead of via a helper Lambda
    // (the CDK default), so the same template deploys to LocalStack. The stack id is part of the
    // name so several copies (say, staging and prod) can live in one account and region.
    if (!/^[a-z0-9][a-z0-9-]{0,25}$/.test(id.toLowerCase())) {
      throw new Error(`Stack id "${id}" must be 1-26 letters, digits or hyphens: it becomes part of the bucket name`);
    }
    const bucketName = `${id.toLowerCase()}-uploads-${Aws.ACCOUNT_ID}-${Aws.REGION}`;
    const bucket = new s3.Bucket(this, 'UploadBucket', {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Versioning makes (key, versionId) a stable idempotency key for the worker.
      versioned: true,
      removalPolicy: removal,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: props.allowedOrigins,
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag', 'x-amz-checksum-sha256'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart-uploads',
          // Parts of abandoned uploads are billed until aborted. Two days leaves room to resume.
          abortIncompleteMultipartUploadAfter: Duration.days(2),
        },
        { id: 'expire-noncurrent-versions', noncurrentVersionExpiration: Duration.days(30) },
        { id: 'expire-delete-markers', expiredObjectDeleteMarker: true },
      ],
    });

    const table = new dynamodb.Table(this, 'FilesTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: removal,
      ...(local ? {} : { pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true } }),
    });
    table.addGlobalSecondaryIndex({
      indexName: 'byUser',
      partitionKey: { name: 'gsiUser', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsiCreated', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ------------------------------------------------------------- processing
    const dlq = new sqs.Queue(this, 'ProcessingDlq', {
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, 'ProcessingQueue', {
      // Must exceed the consumer's timeout (AWS recommends 6x) or messages reappear mid-run.
      visibilityTimeout: Duration.seconds(WORKER_TIMEOUT.toSeconds() * 6),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: dlq, maxReceiveCount: MAX_RECEIVE_COUNT },
    });

    // Only objects under uploads/ trigger work, so writing thumbnails can't loop.
    const enqueuePolicy = queue.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowS3ToEnqueue',
        principals: [new iam.ServicePrincipal('s3.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [queue.queueArn],
        conditions: {
          ArnEquals: { 'aws:SourceArn': `arn:${Aws.PARTITION}:s3:::${bucketName}` },
          StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        },
      }),
    );
    const cfnBucket = bucket.node.defaultChild as s3.CfnBucket;
    cfnBucket.notificationConfiguration = {
      queueConfigurations: [
        {
          event: 's3:ObjectCreated:*',
          queue: queue.queueArn,
          filter: { s3Key: { rules: [{ name: 'prefix', value: 'uploads/' }] } },
        },
      ],
    };
    // S3 validates the queue's policy when the notification is saved, so the policy must exist first.
    if (enqueuePolicy.policyDependable) cfnBucket.node.addDependency(enqueuePolicy.policyDependable);

    const worker = new NodejsFunction(this, 'ProcessUploadFn', {
      entry: path.join(repoRoot, 'functions', 'src', 'process-upload', 'handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Graviton is cheaper on AWS. LocalStack runs the function in a container on this machine,
      // so locally match the host (the bundle is pure JavaScript and runs on either).
      architecture: local && process.arch !== 'arm64' ? lambda.Architecture.X86_64 : lambda.Architecture.ARM_64,
      memorySize: 1536,
      timeout: WORKER_TIMEOUT,
      logGroup: new logs.LogGroup(this, 'WorkerLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        TABLE_NAME: table.tableName,
        BUCKET_NAME: bucket.bucketName,
        MAX_RECEIVE_COUNT: String(MAX_RECEIVE_COUNT),
        LEASE_MS: String(WORKER_TIMEOUT.toMilliseconds() + 60_000),
        // Lambda containers inside LocalStack reach S3 as plain "localstack": path-style needed.
        ...(local ? { S3_FORCE_PATH_STYLE: 'true' } : {}),
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node22',
        // The Node 22 runtime ships AWS SDK v3; LocalStack's does too.
        externalModules: ['@aws-sdk/*'],
      },
    });
    worker.addEventSource(
      new SqsEventSource(queue, { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 5 }),
    );

    // Least privilege for the worker: read uploads, write thumbnails, touch two DynamoDB actions.
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'ReadUploadedObjects',
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [bucket.arnForObjects('uploads/*')],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'WriteThumbnails',
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('thumbnails/*')],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'FileRecordsAndLedger',
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [table.tableArn],
      }),
    );

    // ----------------------------------------------------------------- alarms
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', { enforceSSL: true });
    if (props.alarmEmail) alarmTopic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const alarmAction = new cw_actions.SnsAction(alarmTopic);

    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqNotEmptyAlarm', {
      alarmDescription: 'A file failed processing repeatedly and landed in the dead-letter queue.',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1), statistic: 'Maximum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqAlarm.addAlarmAction(alarmAction);

    const backlogAlarm = new cloudwatch.Alarm(this, 'QueueBacklogAlarm', {
      alarmDescription: 'Uploads have been waiting for processing for over an hour.',
      metric: queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: 3600,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    backlogAlarm.addAlarmAction(alarmAction);

    const errorsAlarm = new cloudwatch.Alarm(this, 'WorkerErrorsAlarm', {
      alarmDescription: 'The processing Lambda is erroring (throttles or crashes, not per-file failures).',
      metric: worker.metricErrors({ period: Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errorsAlarm.addAlarmAction(alarmAction);

    // -------------------------------------------------------------------- API
    // What the API's identity needs and nothing more. Attach it to any role you run the API under.
    const apiPolicy = new iam.ManagedPolicy(this, 'ApiPolicy', {
      description: 'Least-privilege access for the upload API (presign, list parts, complete, status).',
      statements: [
        new iam.PolicyStatement({
          sid: 'MultipartUploads',
          // s3:PutObject also authorises UploadPart; ListMultipartUploadParts backs ListParts.
          actions: ['s3:PutObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'],
          resources: [bucket.arnForObjects('uploads/*')],
        }),
        new iam.PolicyStatement({
          sid: 'VerifyAndDiscardObjects',
          // GetObjectVersion: downloads are pinned to the verified version. The delete actions
          // cover discarding a failed upload and deleting a finished file (every version of it).
          actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:DeleteObject', 's3:DeleteObjectVersion'],
          resources: [bucket.arnForObjects('uploads/*')],
        }),
        new iam.PolicyStatement({
          sid: 'ReadThumbnails',
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('thumbnails/*')],
        }),
        new iam.PolicyStatement({
          sid: 'DiscardThumbnails',
          actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
          resources: [bucket.arnForObjects('thumbnails/*')],
        }),
        new iam.PolicyStatement({
          sid: 'ListObjectVersions',
          // Finding every version of a file's objects before deleting them. Bucket-level, so the
          // prefixes it may list are limited by condition.
          actions: ['s3:ListBucketVersions'],
          resources: [bucket.bucketArn],
          conditions: { StringLike: { 's3:prefix': ['uploads/*', 'thumbnails/*'] } },
        }),
        new iam.PolicyStatement({
          sid: 'FileRecords',
          actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'],
          resources: [table.tableArn, `${table.tableArn}/index/byUser`],
        }),
      ],
    });

    let apiUrl: string | undefined;
    if (props.deployApi) {
      const authEnvironment = apiAuthEnvironment(props.auth);
      const apiMaxTasks = props.apiMaxTasks ?? 4;
      if (!Number.isInteger(apiMaxTasks) || apiMaxTasks < 1) throw new Error(`apiMaxTasks must be a whole number of at least 1, got ${apiMaxTasks}`);
      // No NAT gateway (≈$32/month): tasks sit in public subnets and only the ALB accepts traffic.
      const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 0 });
      const certificate = props.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'ApiCertificate', props.certificateArn)
        : undefined;
      const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Api', {
        vpc,
        cpu: 256,
        memoryLimitMiB: 512,
        minHealthyPercent: 100,
        assignPublicIp: true,
        circuitBreaker: { rollback: true },
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
        certificate,
        redirectHTTP: !!certificate,
        // Browsers hold SSE connections open; keep the ALB from cutting them off between heartbeats.
        idleTimeout: Duration.seconds(120),
        taskImageOptions: {
          containerPort: 3001,
          // Build for the platform the task runs on, whatever machine runs `cdk deploy`.
          image: ecs.ContainerImage.fromAsset(repoRoot, { file: 'apps/api/Dockerfile', platform: ecr_assets.Platform.LINUX_AMD64 }),
          environment: {
            BUCKET_NAME: bucket.bucketName,
            TABLE_NAME: table.tableName,
            CORS_ORIGINS: props.allowedOrigins.join(','),
            PORT: '3001',
            // Don't rely on the platform injecting it: signing and the SDK need the right region.
            AWS_REGION: Aws.REGION,
            // The ALB is the one proxy in front of the API: trust its X-Forwarded-For, and no more,
            // so per-address rate limits see real client addresses that clients cannot forge.
            TRUST_PROXY_HOPS: '1',
            ...authEnvironment,
          },
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: 'api',
            logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
          }),
        },
      });
      service.targetGroup.configureHealthCheck({ path: '/health' });
      // Autoscaling owns the task count: a pinned DesiredCount would reset it on every deploy.
      (service.service.node.defaultChild as ecs.CfnService).desiredCount = undefined;
      addApiScaling(service, apiMaxTasks);
      addApiAlarms(this, service, alarmAction);
      service.taskDefinition.taskRole.addManagedPolicy(apiPolicy);
      apiUrl = `${certificate ? 'https' : 'http'}://${service.loadBalancer.loadBalancerDnsName}`;
      new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    }

    // ---------------------------------------------------------------- outputs
    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new CfnOutput(this, 'WorkerFunctionName', { value: worker.functionName });
    new CfnOutput(this, 'ApiPolicyArn', { value: apiPolicy.managedPolicyArn });
    new CfnOutput(this, 'AlarmTopicArn', { value: alarmTopic.topicArn });
  }
}

/**
 * One task is the floor. Tasks are added when CPU is busy or when requests per task climb; the
 * request target sits well under the default per-address and per-user rate limits, because those
 * counters are kept per task (see the README).
 */
function addApiScaling(service: ecsPatterns.ApplicationLoadBalancedFargateService, maxCapacity: number): void {
  const scaling = service.service.autoScaleTaskCount({ minCapacity: 1, maxCapacity });
  scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60, scaleInCooldown: Duration.minutes(5), scaleOutCooldown: Duration.minutes(1) });
  scaling.scaleOnRequestCount('Requests', {
    requestsPerTarget: 3000, // per minute, per task
    targetGroup: service.targetGroup,
    scaleInCooldown: Duration.minutes(5),
    scaleOutCooldown: Duration.minutes(1),
  });
}

/** Alarms that say "the API is hurting" without paging for a quiet night (no data is not a breach). */
function addApiAlarms(scope: Construct, service: ecsPatterns.ApplicationLoadBalancedFargateService, action: cloudwatch.IAlarmAction): void {
  const make = (id: string, description: string, metric: cloudwatch.IMetric, threshold: number, evaluationPeriods: number, datapointsToAlarm = evaluationPeriods) => {
    const alarm = new cloudwatch.Alarm(scope, id, {
      alarmDescription: description,
      metric,
      threshold,
      evaluationPeriods,
      datapointsToAlarm,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(action);
  };
  const five = Duration.minutes(5);
  const lb = service.loadBalancer.metrics;
  const tg = service.targetGroup.metrics;

  make('ApiServerErrorsAlarm', 'The API is answering with 5xx errors (a bug or a failing dependency).', tg.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: five, statistic: 'Sum' }), 10, 1);
  make('ApiLoadBalancerErrorsAlarm', 'The load balancer itself is returning 5xx (no healthy task, or tasks are refusing connections).', lb.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: five, statistic: 'Sum' }), 5, 1);
  make('ApiUnhealthyTargetsAlarm', 'An API task is failing its health check.', tg.unhealthyHostCount({ period: Duration.minutes(1), statistic: 'Maximum' }), 1, 3);
  make('ApiSlowResponsesAlarm', 'API responses are slow: p95 time to first byte is over three seconds.', tg.targetResponseTime({ period: five, statistic: 'p95' }), 3, 3);
  make('ApiHighCpuAlarm', 'API CPU has been above 85% for 15 minutes; autoscaling is at its ceiling or not keeping up.', service.service.metricCpuUtilization({ period: five }), 85, 3);
  make('ApiHighMemoryAlarm', 'API memory has been above 85% for 15 minutes; the task may be about to be killed.', service.service.metricMemoryUtilization({ period: five }), 85, 3);
}

/**
 * Environment that picks the API's auth mode. The image runs with NODE_ENV=production, where the
 * API refuses the demo header auth unless it is explicitly allowed, so the choice must be made here.
 */
function apiAuthEnvironment(auth: ApiAuth | undefined): Record<string, string> {
  if (!auth) {
    throw new Error(
      'deployApi needs an auth choice: pass -c jwtIssuer=... -c jwtAudience=... -c jwtJwksUrl=https://... ' +
        '(or -c insecureDemoAuth=true to accept that anyone can impersonate any user)',
    );
  }
  if (auth.mode === 'header') return { AUTH_MODE: 'header', ALLOW_INSECURE_DEMO_AUTH: 'true' };
  if (!auth.issuer || !auth.audience) throw new Error('JWT auth needs both an issuer and an audience');
  if (!/^https:\/\//.test(auth.jwksUrl)) throw new Error('The JWKS URL must be an https URL');
  return { AUTH_MODE: 'jwt', JWT_ISSUER: auth.issuer, JWT_AUDIENCE: auth.audience, JWT_JWKS_URL: auth.jwksUrl };
}

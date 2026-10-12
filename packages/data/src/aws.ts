import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Clients rely on the SDK's standard environment handling, so pointing the whole
 * stack at LocalStack is just `AWS_ENDPOINT_URL=http://localhost:4566` plus dummy
 * credentials. The one extra knob is path-style S3 addressing, which LocalStack
 * needs when it is reached as plain `localhost`.
 */
export function createS3Client(overrides: S3ClientConfig = {}): S3Client {
  return new S3Client({
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    // Only compute checksums we ask for; presigned URLs must not grow surprise headers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    ...overrides,
  });
}

export function createDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

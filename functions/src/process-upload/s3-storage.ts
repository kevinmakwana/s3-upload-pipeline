import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { ObjectStorage } from './processor';

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async head(key: string, versionId?: string) {
    const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }));
    return { size: res.ContentLength ?? 0, etag: res.ETag };
  }

  async readHead(key: string, versionId: string | undefined, length: number) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId, Range: `bytes=0-${length - 1}` }));
    return res.Body!.transformToByteArray();
  }

  async stream(key: string, versionId?: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }));
    return res.Body as Readable;
  }

  async readAll(key: string, versionId?: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: versionId }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async putThumbnail(key: string, body: Buffer) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'image/jpeg' }));
  }
}

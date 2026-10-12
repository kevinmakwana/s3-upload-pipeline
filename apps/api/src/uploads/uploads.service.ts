import { randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PlanError,
  buildObjectKey,
  partRange,
  planParts,
  validateUpload,
  type FileDto,
  type InitUploadRequest,
  type ListPartsResponse,
  type PresignPartResponse,
  type RemotePart,
} from '@s3up/core';
import { toDto, type FileRecord, type FileStore } from '@s3up/data';
import type { AppConfig } from '../config';
import { CONFIG, FILES, S3, S3_PRESIGNER } from '../common/tokens';
import { expectedCompositeSha256, expectedMultipartEtag, normalizeEtag, type PartDigest } from './integrity';

const SHA256_B64 = /^[A-Za-z0-9+/]{43}=$/;

@Injectable()
export class UploadsService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(S3_PRESIGNER) private readonly presigner: S3Client,
    @Inject(FILES) private readonly files: FileStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Validates the request, plans the parts and opens the multipart upload. */
  async init(userId: string, req: InitUploadRequest): Promise<FileDto> {
    const problems = validateUpload(req, this.config.rules);
    if (problems.length) throw new BadRequestException(problems);

    let plan;
    try {
      plan = planParts(req.fileSize, { preferredPartSize: this.config.preferredPartSize });
    } catch (err) {
      if (err instanceof PlanError) throw new BadRequestException(err.message);
      throw err;
    }

    const id = randomUUID();
    const key = buildObjectKey(userId, id, req.fileName);
    const created = await this.s3.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: req.contentType,
        // Per-part SHA-256 is verified by S3 on upload and reported back by ListParts.
        ChecksumAlgorithm: 'SHA256',
        Metadata: { 'original-name': encodeURIComponent(req.fileName), 'file-id': id },
      }),
    );
    if (!created.UploadId) throw new Error('S3 did not return an UploadId');

    const at = this.now();
    const record: FileRecord = {
      id,
      userId,
      fileName: req.fileName,
      contentType: req.contentType,
      size: req.fileSize,
      status: 'uploading',
      partSize: plan.partSize,
      partCount: plan.partCount,
      s3Key: key,
      s3UploadId: created.UploadId,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
      expiresAt: Math.floor(at.getTime() / 1000) + this.config.pendingTtlSeconds,
    };
    await this.files.create(record);
    return toDto(record);
  }

  /** What S3 holds for this upload: the reconciliation input for resume. */
  async listParts(userId: string, fileId: string): Promise<ListPartsResponse> {
    const record = await this.owned(userId, fileId);
    if (record.status !== 'uploading') return { file: toDto(record), parts: [] };
    const parts = await this.fetchParts(record);
    return { file: toDto(record), parts };
  }

  /** Signs a PUT for exactly one part of exactly one upload, bound to its size and checksum. */
  async presignPart(userId: string, fileId: string, partNumber: number, sha256: string): Promise<PresignPartResponse> {
    const record = await this.owned(userId, fileId);
    if (record.status !== 'uploading') throw new ConflictException(`Upload is ${record.status}, not accepting parts`);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > record.partCount) {
      throw new BadRequestException(`partNumber must be an integer between 1 and ${record.partCount}`);
    }
    if (!SHA256_B64.test(sha256)) throw new BadRequestException('sha256 must be a base64-encoded SHA-256 digest');

    const { size } = partRange({ fileSize: record.size, partSize: record.partSize, partCount: record.partCount }, partNumber);
    const command = new UploadPartCommand({
      Bucket: this.config.bucket,
      Key: record.s3Key,
      UploadId: record.s3UploadId,
      PartNumber: partNumber,
      ContentLength: size,
      ChecksumSHA256: sha256,
    });
    const url = await getSignedUrl(this.presigner, command, {
      expiresIn: this.config.presignExpiresSeconds,
      // Sign the checksum header so S3 rejects bytes that don't hash to what we were told.
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      signableHeaders: new Set(['content-length']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'x-amz-checksum-sha256': sha256 },
      expiresAt: new Date(this.now().getTime() + this.config.presignExpiresSeconds * 1000).toISOString(),
    };
  }

  /**
   * Stitches the parts together after checking S3 has exactly the planned parts, then
   * verifies the final ETag and checksum against what ListParts reported.
   */
  async complete(userId: string, fileId: string): Promise<FileDto> {
    const record = await this.owned(userId, fileId);
    if (record.status !== 'uploading') {
      if (record.status === 'aborted') throw new ConflictException('Upload was aborted');
      return toDto(record); // retried request after success: idempotent
    }

    const parts = await this.fetchParts(record);
    this.assertComplete(record, parts);
    const digests: PartDigest[] = parts.map((p) => ({ etag: p.etag!, sha256: p.sha256! }));

    const done = await this.s3
      .send(
        new CompleteMultipartUploadCommand({
          Bucket: this.config.bucket,
          Key: record.s3Key,
          UploadId: record.s3UploadId,
          MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag, ChecksumSHA256: p.sha256 })) },
        }),
      )
      .catch((err) => this.rethrowS3(err));

    const problems = await this.verifyObject(record, digests, done);
    if (problems.length) {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: record.s3Key, VersionId: done.VersionId }))
        .catch(() => undefined);
      await this.files.markFailed(record.id, `Integrity check failed: ${problems.join('; ')}`, this.now().toISOString());
      throw new UnprocessableEntityException({ message: 'Integrity check failed', problems });
    }

    const updated = await this.files.markUploaded(record.id, {
      etag: normalizeEtag(done.ETag),
      versionId: done.VersionId,
      at: this.now().toISOString(),
    });
    return toDto(updated ?? record);
  }

  /** Aborts the multipart upload so S3 frees the stored parts. */
  async abort(userId: string, fileId: string): Promise<void> {
    const record = await this.owned(userId, fileId);
    if (record.status === 'aborted') return;
    if (record.status !== 'uploading') throw new ConflictException(`Cannot abort an upload that is ${record.status}`);
    await this.s3
      .send(new AbortMultipartUploadCommand({ Bucket: this.config.bucket, Key: record.s3Key, UploadId: record.s3UploadId }))
      .catch((err) => {
        if (err?.name !== 'NoSuchUpload') throw err;
      });
    await this.files.markAborted(record.id, this.now().toISOString());
  }

  private async owned(userId: string, fileId: string): Promise<FileRecord> {
    const record = await this.files.get(fileId);
    // Someone else's file looks exactly like a missing one.
    if (!record || record.userId !== userId) throw new NotFoundException('Upload not found');
    return record;
  }

  private async fetchParts(record: FileRecord): Promise<RemotePart[]> {
    const parts: RemotePart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.s3
        .send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: record.s3Key,
            UploadId: record.s3UploadId,
            PartNumberMarker: marker,
            MaxParts: 1000,
          }),
        )
        .catch((err) => this.rethrowS3(err));
      for (const p of page.Parts ?? []) {
        parts.push({ partNumber: p.PartNumber!, size: p.Size ?? 0, etag: p.ETag, sha256: p.ChecksumSHA256 });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  private assertComplete(record: FileRecord, parts: RemotePart[]): void {
    const plan = { fileSize: record.size, partSize: record.partSize, partCount: record.partCount };
    const have = new Map(parts.map((p) => [p.partNumber, p]));
    const missing: number[] = [];
    const wrongSize: number[] = [];
    for (let n = 1; n <= plan.partCount; n++) {
      const p = have.get(n);
      if (!p || !p.etag || !p.sha256) missing.push(n);
      else if (p.size !== partRange(plan, n).size) wrongSize.push(n);
    }
    if (missing.length || wrongSize.length) {
      throw new BadRequestException({
        message: 'Upload is not complete',
        missingParts: missing.slice(0, 100),
        wrongSizeParts: wrongSize.slice(0, 100),
      });
    }
  }

  private async verifyObject(
    record: FileRecord,
    digests: PartDigest[],
    done: { ETag?: string; ChecksumSHA256?: string },
  ): Promise<string[]> {
    const problems: string[] = [];
    const etag = normalizeEtag(done.ETag);
    const expected = expectedMultipartEtag(digests);
    if (etag !== expected) problems.push(`ETag ${etag} does not match the ${expected} computed from the parts`);

    if (done.ChecksumSHA256) {
      const expectedSha = expectedCompositeSha256(digests);
      if (done.ChecksumSHA256 !== expectedSha) problems.push('composite SHA-256 mismatch');
    }
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: record.s3Key }));
    if (head.ContentLength !== record.size) problems.push(`stored size ${head.ContentLength} != declared ${record.size}`);
    return problems;
  }

  private rethrowS3(err: unknown): never {
    if ((err as { name?: string })?.name === 'NoSuchUpload') throw new GoneException('The multipart upload no longer exists');
    throw err;
  }
}

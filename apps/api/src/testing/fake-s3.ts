import { createHash, randomBytes } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
} from '@aws-sdk/client-s3';

interface Upload {
  key: string;
  parts: Map<number, { size: number; etag: string; sha256: string }>;
}

/** Just enough of S3 multipart semantics for service-level tests. */
export class FakeS3 {
  uploads = new Map<string, Upload>();
  objects = new Map<string, { size: number }>();
  commands: unknown[] = [];
  deleted: unknown[] = [];
  /** Tamper with the ETag S3 returns from CompleteMultipartUpload. */
  corruptEtag = false;
  listPageSize = 1000;
  private counter = 0;

  async send(command: unknown): Promise<any> {
    this.commands.push(command);
    if (command instanceof CreateMultipartUploadCommand) {
      const uploadId = `upload-${++this.counter}`;
      this.uploads.set(uploadId, { key: command.input.Key!, parts: new Map() });
      return { UploadId: uploadId };
    }
    if (command instanceof ListPartsCommand) {
      const up = this.mustGet(command.input.UploadId!);
      const all = [...up.parts.entries()].sort((a, b) => a[0] - b[0]);
      const from = command.input.PartNumberMarker ? Number(command.input.PartNumberMarker) : 0;
      const page = all.filter(([n]) => n > from).slice(0, this.listPageSize);
      const truncated = all.filter(([n]) => n > from).length > page.length;
      return {
        Parts: page.map(([n, p]) => ({ PartNumber: n, Size: p.size, ETag: `"${p.etag}"`, ChecksumSHA256: p.sha256 })),
        IsTruncated: truncated,
        NextPartNumberMarker: truncated ? String(page.at(-1)![0]) : undefined,
      };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const up = this.mustGet(command.input.UploadId!);
      const ordered = [...up.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
      const etag = createHash('md5').update(Buffer.concat(ordered.map((p) => Buffer.from(p.etag, 'hex')))).digest('hex');
      const sha = createHash('sha256').update(Buffer.concat(ordered.map((p) => Buffer.from(p.sha256, 'base64')))).digest('base64');
      this.objects.set(up.key, { size: ordered.reduce((n, p) => n + p.size, 0) });
      this.uploads.delete(command.input.UploadId!);
      return { ETag: `"${this.corruptEtag ? 'f'.repeat(32) : etag}-${ordered.length}"`, ChecksumSHA256: `${sha}-${ordered.length}`, VersionId: 'v1' };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      this.mustGet(command.input.UploadId!);
      this.uploads.delete(command.input.UploadId!);
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const o = this.objects.get(command.input.Key!);
      if (!o) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      return { ContentLength: o.size };
    }
    if (command instanceof DeleteObjectCommand) {
      this.deleted.push(command.input);
      this.objects.delete(command.input.Key!);
      return {};
    }
    throw new Error(`FakeS3: unsupported command ${(command as object).constructor.name}`);
  }

  /** Simulates a browser PUT of a part landing in S3. */
  putPart(uploadId: string, partNumber: number, size: number, sha256 = randomBytes(32).toString('base64')) {
    this.mustGet(uploadId).parts.set(partNumber, { size, etag: randomBytes(16).toString('hex'), sha256 });
  }

  private mustGet(uploadId: string): Upload {
    const up = this.uploads.get(uploadId);
    if (!up) throw Object.assign(new Error('The specified upload does not exist'), { name: 'NoSuchUpload' });
    return up;
  }
}

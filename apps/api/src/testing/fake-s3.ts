import { createHash, randomBytes } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
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
  /** Every stored version and delete marker, which is what a versioned bucket really keeps. */
  versions: { Key: string; VersionId: string; marker: boolean }[] = [];
  versionPageSize = 1000;
  /** Object tags by `key#versionId`, as GuardDuty would write them. */
  tags = new Map<string, Record<string, string>>();
  /** Make GetObjectTagging fail, as when the API's role may not read tags. */
  failTagging = false;
  /** Keys that DeleteObjects reports as failed. */
  failDeleteKeys = new Set<string>();
  /** Tamper with the ETag S3 returns from CompleteMultipartUpload. */
  corruptEtag = false;
  listPageSize = 1000;
  private counter = 0;

  // Stands in for S3Client.send, whose result type depends on the command; callers cast it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      const etag = createHash('md5')
        .update(Buffer.concat(ordered.map((p) => Buffer.from(p.etag, 'hex'))))
        .digest('hex');
      const sha = createHash('sha256')
        .update(Buffer.concat(ordered.map((p) => Buffer.from(p.sha256, 'base64'))))
        .digest('base64');
      this.objects.set(up.key, { size: ordered.reduce((n, p) => n + p.size, 0) });
      this.versions.push({ Key: up.key, VersionId: 'v1', marker: false });
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
    if (command instanceof ListObjectVersionsCommand) {
      // Markers are positions (key, then version id), as in S3, so deleting earlier entries between pages is safe.
      const order = (a: { Key: string; VersionId: string }, b: { Key: string; VersionId: string }) =>
        a.Key.localeCompare(b.Key) || a.VersionId.localeCompare(b.VersionId);
      const { KeyMarker, VersionIdMarker } = command.input;
      const after = (v: { Key: string; VersionId: string }) => !KeyMarker || order(v, { Key: KeyMarker, VersionId: VersionIdMarker ?? '' }) > 0;
      const matching = this.versions.filter((v) => v.Key.startsWith(command.input.Prefix ?? '') && after(v)).sort(order);
      const page = matching.slice(0, this.versionPageSize);
      const truncated = matching.length > page.length;
      return {
        Versions: page.filter((v) => !v.marker).map(({ Key, VersionId }) => ({ Key, VersionId })),
        DeleteMarkers: page.filter((v) => v.marker).map(({ Key, VersionId }) => ({ Key, VersionId })),
        IsTruncated: truncated,
        NextKeyMarker: truncated ? page.at(-1)!.Key : undefined,
        NextVersionIdMarker: truncated ? page.at(-1)!.VersionId : undefined,
      };
    }
    if (command instanceof GetObjectTaggingCommand) {
      if (this.failTagging) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied' });
      const { Key, VersionId } = command.input;
      if (!this.versions.some((v) => v.Key === Key && v.VersionId === VersionId)) throw Object.assign(new Error('NoSuchVersion'), { name: 'NoSuchVersion' });
      const tags = this.tags.get(`${Key}#${VersionId}`) ?? {};
      return { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) };
    }
    if (command instanceof DeleteObjectsCommand) {
      const Errors: { Key: string; VersionId?: string; Code: string }[] = [];
      for (const { Key, VersionId } of command.input.Delete!.Objects!) {
        if (this.failDeleteKeys.has(Key!)) {
          Errors.push({ Key: Key!, VersionId, Code: 'AccessDenied' });
          continue;
        }
        this.versions = this.versions.filter((v) => !(v.Key === Key && v.VersionId === VersionId));
        if (!this.versions.some((v) => v.Key === Key && !v.marker)) this.objects.delete(Key!);
      }
      this.deleted.push(command.input);
      return Errors.length ? { Errors } : {};
    }
    throw new Error(`FakeS3: unsupported command ${(command as object).constructor.name}`);
  }

  /** Puts a stored version (or a delete marker) straight into the bucket. */
  addVersion(key: string, versionId: string, marker = false) {
    this.versions.push({ Key: key, VersionId: versionId, marker });
    if (!marker) this.objects.set(key, { size: 1 });
  }

  /** What GuardDuty does after scanning: tag the exact version with its verdict. */
  tag(key: string, versionId: string, tags: Record<string, string>) {
    this.tags.set(`${key}#${versionId}`, { ...this.tags.get(`${key}#${versionId}`), ...tags });
  }

  /** Version ids currently stored for exactly this key. */
  versionsOf(key: string): string[] {
    return this.versions
      .filter((v) => v.Key === key)
      .map((v) => v.VersionId)
      .sort();
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

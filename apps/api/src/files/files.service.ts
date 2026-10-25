import { GetObjectCommand, GetObjectTaggingCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_PAGE_SIZE, buildThumbnailKey, type DownloadUrlResponse, type FileDto, type FilePage } from '@s3up/core';
import { InvalidCursorError, deleteAllVersions, toDto, type FileRecord, type FileStore, type RecordPage } from '@s3up/data';
import { filter, interval, map, merge, of, switchMap, type Observable } from 'rxjs';
import type { AppConfig } from '../config';
import { CHANGE_FEED, CONFIG, FILES, S3, S3_PRESIGNER } from '../common/tokens';
import type { ChangeFeed } from './change-feed';
import { attachmentDisposition } from './content-disposition';

/** The object tag GuardDuty Malware Protection for S3 writes its verdict to. */
const SCAN_STATUS_TAG = 'GuardDutyMalwareScanStatus';

@Injectable()
export class FilesService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(S3) private readonly s3: S3Client,
    @Inject(S3_PRESIGNER) private readonly presigner: S3Client,
    @Inject(FILES) private readonly files: FileStore,
    @Inject(CHANGE_FEED) private readonly feed: ChangeFeed,
  ) {}

  /** One page of the caller's files, newest first. Aborted uploads are bookkeeping, not shown. */
  async list(userId: string, { limit = DEFAULT_PAGE_SIZE, cursor }: { limit?: number; cursor?: string } = {}): Promise<FilePage> {
    const page = await this.page(userId, limit, cursor);
    return { files: await this.toDtos(page.items), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  }

  async get(userId: string, fileId: string): Promise<FileDto> {
    // An aborted upload is still visible here (with status "aborted"); it just isn't listed.
    return this.toDto(await this.owned(userId, fileId, { includeAborted: true }));
  }

  /** A short-lived link that downloads the original file, as an attachment under its own name. */
  async downloadUrl(userId: string, fileId: string): Promise<DownloadUrlResponse> {
    const record = await this.owned(userId, fileId);
    if (record.status === 'quarantined') throw new ConflictException('This file was quarantined because a scan found malware in it');
    if (record.status !== 'ready') throw new ConflictException(`File is ${record.status}, not ready to download`);
    if (this.config.malwareScan) await this.requireCleanScan(record);
    const expiresIn = this.config.downloadUrlExpiresSeconds;
    const url = await getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: record.s3Key,
        VersionId: record.versionId, // the exact object that was verified and processed
        ResponseContentDisposition: attachmentDisposition(record.fileName),
        ResponseContentType: record.contentType,
      }),
      { expiresIn },
    );
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  /**
   * GuardDuty tags each scanned version with its verdict. Only a clean verdict on the exact version
   * we would hand out lets a download through; no tag yet means the scan has not finished. If the tags
   * cannot be read the error propagates (a 500), so a failure never turns into permission.
   */
  private async requireCleanScan(record: FileRecord): Promise<void> {
    const { TagSet } = await this.s3.send(new GetObjectTaggingCommand({ Bucket: this.config.bucket, Key: record.s3Key, VersionId: record.versionId }));
    const verdict = TagSet?.find((t) => t.Key === SCAN_STATUS_TAG)?.Value;
    if (verdict === 'NO_THREATS_FOUND') return;
    if (!verdict) throw new ConflictException('This file is still being scanned for malware; try again in a minute');
    if (verdict === 'THREATS_FOUND') throw new ConflictException('A scan found malware in this file, so it cannot be downloaded');
    throw new ConflictException(`This file could not be scanned (${verdict}), so it cannot be downloaded`);
  }

  /**
   * Permanently deletes a finished file: every stored version of the object and of its thumbnail
   * (the bucket is versioned, so a plain delete would only add a marker), then the record.
   * Storage goes first: if that fails the record is still there and the request can be retried.
   */
  async delete(userId: string, fileId: string): Promise<void> {
    const record = await this.owned(userId, fileId);
    if (record.status !== 'ready' && record.status !== 'failed' && record.status !== 'quarantined') {
      throw new ConflictException(
        record.status === 'uploading' ? 'Upload is still in progress; cancel it instead' : `File is ${record.status}; try again when processing has finished`,
      );
    }
    await deleteAllVersions(this.s3, this.config.bucket, record.s3Key);
    await deleteAllVersions(this.s3, this.config.bucket, record.result?.thumbnailKey ?? buildThumbnailKey(record.userId, record.id));
    if (!(await this.files.remove(record.id))) throw new ConflictException('File changed while it was being deleted; try again');
  }

  /**
   * Server-sent events: a `files` event with the newest page (and the cursor for the rest)
   * whenever anything on it changes, plus a periodic `ping` so proxies keep the connection open.
   * Older pages are not pushed; clients fetch them with GET /files?cursor=.
   *
   * The list is read once when the connection opens and again whenever the change feed says something may have
   * changed; an event goes out only if the page differs from the one last sent. The feed is a push from DynamoDB
   * Streams when the stack provides one, and a timer otherwise (see change-feed.ts).
   */
  stream(userId: string): Observable<{ type: string; data: FilePage | object }> {
    // Undefined until the first page goes out, so a user with no files still hears from the server on connecting.
    let sent: string | undefined;
    const pages = merge(of(undefined), this.feed.changes(userId)).pipe(
      // A newer signal abandons a read still in flight, so the last read always starts after the last signal.
      switchMap(async () => {
        const page = await this.page(userId, DEFAULT_PAGE_SIZE);
        const signature = page.items.map((r) => `${r.id}:${r.status}:${r.updatedAt}`).join('|') + (page.nextCursor ? '+' : '');
        if (signature === sent) return undefined; // nothing new: skip building the links
        const data: FilePage = { files: await this.toDtos(page.items), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
        return { signature, event: { type: 'files', data } };
      }),
      // Remember a page only once it is about to go out, so an abandoned read can never hide a change.
      filter((read): read is NonNullable<typeof read> => {
        if (!read || read.signature === sent) return false;
        sent = read.signature;
        return true;
      }),
      map(({ event }) => event),
    );
    const pings = interval(15_000).pipe(map(() => ({ type: 'ping', data: {} })));
    return merge(pages, pings);
  }

  private async owned(userId: string, fileId: string, { includeAborted = false } = {}): Promise<FileRecord> {
    const record = await this.files.get(fileId);
    // Someone else's file looks exactly like a missing one. So does an aborted upload, unless asked for.
    if (!record || record.userId !== userId || (record.status === 'aborted' && !includeAborted)) throw new NotFoundException('File not found');
    return record;
  }

  private async page(userId: string, limit: number, cursor?: string): Promise<RecordPage> {
    try {
      return await this.files.listByUser(userId, { limit, cursor, excludeAborted: true });
    } catch (err) {
      if (err instanceof InvalidCursorError) throw new BadRequestException('Invalid cursor');
      throw err;
    }
  }

  private toDtos(records: FileRecord[]): Promise<FileDto[]> {
    return Promise.all(records.map((r) => this.toDto(r)));
  }

  private async toDto(record: FileRecord): Promise<FileDto> {
    const key = record.result?.thumbnailKey;
    if (record.status !== 'ready' || !key) return toDto(record);
    const thumbnailUrl = await getSignedUrl(this.presigner, new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), {
      expiresIn: this.config.thumbnailUrlExpiresSeconds,
    });
    return toDto(record, { thumbnailUrl });
  }
}

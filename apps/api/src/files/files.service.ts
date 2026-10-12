import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { FileDto } from '@s3up/core';
import { toDto, type FileRecord, type FileStore } from '@s3up/data';
import { Observable, interval } from 'rxjs';
import type { AppConfig } from '../config';
import { CONFIG, FILES, S3_PRESIGNER } from '../common/tokens';

@Injectable()
export class FilesService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(S3_PRESIGNER) private readonly presigner: S3Client,
    @Inject(FILES) private readonly files: FileStore,
  ) {}

  async list(userId: string): Promise<FileDto[]> {
    return this.toDtos(await this.visible(userId));
  }

  async get(userId: string, fileId: string): Promise<FileDto> {
    const record = await this.files.get(fileId);
    if (!record || record.userId !== userId) throw new NotFoundException('File not found');
    return this.toDto(record);
  }

  /**
   * Server-sent events: a `files` event with the full list whenever anything changes, plus a
   * periodic `ping` so proxies keep the connection open. State is polled from DynamoDB per
   * connection; at larger scale you would fan out from a DynamoDB Stream instead.
   */
  stream(userId: string): Observable<{ type: string; data: object }> {
    return new Observable((subscriber) => {
      let last = '';
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;

      const tick = async () => {
        try {
          const records = await this.visible(userId);
          const signature = records.map((r) => `${r.id}:${r.status}:${r.updatedAt}`).join('|');
          if (signature !== last && !stopped) {
            last = signature;
            subscriber.next({ type: 'files', data: { files: await this.toDtos(records) } });
          }
        } catch (err) {
          if (!stopped) subscriber.error(err);
          return;
        }
        if (!stopped) timer = setTimeout(tick, this.config.ssePollMs);
      };
      void tick();

      const heartbeat = interval(15_000).subscribe(() => subscriber.next({ type: 'ping', data: {} }));
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        heartbeat.unsubscribe();
      };
    });
  }

  private async visible(userId: string): Promise<FileRecord[]> {
    // Aborted uploads are bookkeeping, not something to show.
    return (await this.files.listByUser(userId)).filter((r) => r.status !== 'aborted');
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

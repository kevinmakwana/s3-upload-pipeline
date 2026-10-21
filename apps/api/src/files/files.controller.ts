import { Controller, Delete, Get, HttpCode, Inject, Param, Query, Sse } from '@nestjs/common';
import { MAX_PAGE_SIZE } from '@s3up/core';
import { map } from 'rxjs';
import { z } from 'zod';
import { CurrentUser } from '../common/user';
import { parse } from '../common/zod';
import { FilesService } from './files.service';

const listQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/, 'must be a whole number').transform(Number).pipe(z.number().min(1).max(MAX_PAGE_SIZE)).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

@Controller('files')
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get()
  list(@CurrentUser() userId: string, @Query() query: unknown) {
    return this.files.list(userId, parse(listQuerySchema, query));
  }

  // Declared before ':id' so "stream" isn't treated as a file id.
  @Sse('stream')
  stream(@CurrentUser() userId: string) {
    return this.files.stream(userId).pipe(map((e) => ({ type: e.type, data: e.data })));
  }

  @Get(':id')
  get(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.files.get(userId, id);
  }

  @Get(':id/download')
  download(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.files.downloadUrl(userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() userId: string, @Param('id') id: string) {
    await this.files.delete(userId, id);
  }
}

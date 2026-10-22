import { Body, Controller, Delete, HttpCode, Inject, Param, ParseIntPipe, Post, Get } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../common/user';
import { parse } from '../common/zod';
import { UploadsService } from './uploads.service';

const initSchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  contentType: z.string().min(1).max(100),
});
const presignSchema = z.object({ sha256: z.string() });

@Controller('uploads')
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  @Post()
  async init(@CurrentUser() userId: string, @Body() body: unknown) {
    return { file: await this.uploads.init(userId, parse(initSchema, body)) };
  }

  @Get(':id/parts')
  listParts(@CurrentUser() userId: string, @Param('id') id: string) {
    return this.uploads.listParts(userId, id);
  }

  @Post(':id/parts/:partNumber/presign')
  @HttpCode(200)
  presign(@CurrentUser() userId: string, @Param('id') id: string, @Param('partNumber', ParseIntPipe) partNumber: number, @Body() body: unknown) {
    return this.uploads.presignPart(userId, id, partNumber, parse(presignSchema, body).sha256);
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(@CurrentUser() userId: string, @Param('id') id: string) {
    return { file: await this.uploads.complete(userId, id) };
  }

  @Delete(':id')
  @HttpCode(204)
  async abort(@CurrentUser() userId: string, @Param('id') id: string) {
    await this.uploads.abort(userId, id);
  }
}

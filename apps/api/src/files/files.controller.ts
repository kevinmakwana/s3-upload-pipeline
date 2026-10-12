import { Controller, Get, Inject, Param, Sse } from '@nestjs/common';
import { map } from 'rxjs';
import { CurrentUser } from '../common/user';
import { FilesService } from './files.service';

@Controller('files')
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get()
  async list(@CurrentUser() userId: string) {
    return { files: await this.files.list(userId) };
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
}

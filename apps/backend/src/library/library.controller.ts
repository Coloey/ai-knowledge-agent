import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ok } from '../common/api-response';
import { LibraryService } from './library.service';

@Controller('library/files')
@UseGuards(JwtAuthGuard)
export class LibraryController {
  constructor(@Inject(LibraryService) private readonly library: LibraryService) {}

  @Post('upload')
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @Query('workspace_id') workspaceId: string,
    @Req() request: FastifyRequest,
  ) {
    const upload = await request.file();
    if (!upload) throw new BadRequestException('Missing upload file');
    return ok(await this.library.upload(user, workspaceId, upload));
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query('workspace_id') workspaceId: string) {
    return ok(await this.library.list(user.id, workspaceId));
  }

  @Get(':fileId')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Query('workspace_id') workspaceId: string,
    @Param('fileId') fileId: string,
  ) {
    return ok(await this.library.get(user.id, workspaceId, fileId));
  }

  @Get(':fileId/parse-status')
  async parseStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Query('workspace_id') workspaceId: string,
    @Param('fileId') fileId: string,
  ) {
    const file = await this.library.get(user.id, workspaceId, fileId);
    return ok({ file_id: file.file_id, parse_status: file.parse_status, error_message: file.error_message });
  }

  @Delete(':fileId')
  async delete(
    @CurrentUser() user: AuthenticatedUser,
    @Query('workspace_id') workspaceId: string,
    @Param('fileId') fileId: string,
  ) {
    await this.library.delete(user.id, workspaceId, fileId);
    return ok({ file_id: fileId });
  }
}

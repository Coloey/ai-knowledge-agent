import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ok } from '../common/api-response';
import { CreateWorkspaceRequestDto } from './workspace.dto';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return ok(await this.workspaces.list(user.id));
  }

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() input: CreateWorkspaceRequestDto) {
    return ok(await this.workspaces.create(user, input.name));
  }

  @Get(':workspaceId')
  async get(@CurrentUser() user: AuthenticatedUser, @Param('workspaceId') workspaceId: string) {
    return ok(await this.workspaces.get(user.id, workspaceId));
  }
}

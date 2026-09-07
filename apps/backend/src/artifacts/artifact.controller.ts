import { Controller, Get, Inject, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ok } from '../common/api-response';
import { ArtifactApplication } from './artifact.application';
import { ArtifactContentQueryDto } from './artifact.dto';

@Controller('artifacts')
@UseGuards(JwtAuthGuard)
export class ArtifactController {
  constructor(@Inject(ArtifactApplication) private readonly artifacts: ArtifactApplication) {}

  @Get(':artifactId')
  async detail(@CurrentUser() user: AuthenticatedUser, @Param('artifactId') artifactId: string) {
    return ok(await this.artifacts.getAuthorized(user.id, artifactId));
  }

  @Get(':artifactId/content')
  async content(
    @CurrentUser() user: AuthenticatedUser,
    @Param('artifactId') artifactId: string,
    @Query() query: ArtifactContentQueryDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const content = await this.artifacts.openAuthorized(user.id, artifactId);
    const requestedDisposition = query.disposition ?? 'attachment';
    const disposition = requestedDisposition === 'inline' && content.inlineAllowed ? 'inline' : 'attachment';
    reply.headers({
      'Content-Type': content.mimeType,
      ...(content.size === undefined ? {} : { 'Content-Length': String(content.size) }),
      'Content-Disposition': contentDisposition(disposition, content.filename, artifactId),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    reply.send(content.body);
  }

  @Post(':artifactId/retry')
  async retry(@CurrentUser() user: AuthenticatedUser, @Param('artifactId') artifactId: string) {
    return ok(await this.artifacts.retryAuthorized(user.id, artifactId));
  }
}

export function contentDisposition(disposition: 'inline' | 'attachment', filename: string, artifactId: string): string {
  const safeName =
    filename
      .replace(/[\\/\r\n]+/g, '-')
      .replace(/^[-.\s]+|[-.\s]+$/g, '')
      .slice(0, 200) || 'artifact';
  const extension = /\.[A-Za-z0-9]{1,12}$/.exec(safeName)?.[0] ?? '';
  const safeId = artifactId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'download';
  const fallback = `artifact-${safeId}${extension}`;
  const encoded = encodeURIComponent(safeName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

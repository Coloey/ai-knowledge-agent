import { Body, Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/auth.types';
import { ok } from '../common/api-response';
import type { Environment } from '../config/environment';
import { parseCorsOrigins } from '../config/environment';
import {
  InterruptRequestDto,
  RateAnswerRequestDto,
  SendMessageRequestDto,
  SessionDetailRequestDto,
  SessionHistoryRequestDto,
} from './session.dto';
import { SessionsService } from './sessions.service';
import { SessionRateLimitGuard } from './session-rate-limit.guard';
import { sseCorsHeaders } from './sse';

@Controller('notta-brain/session')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(ConfigService) private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post('send-message')
  @UseGuards(SessionRateLimitGuard)
  async sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: SendMessageRequestDto,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const context = await this.sessions.prepare(user, input);
    const abort = new AbortController();
    reply.raw.once('close', () => abort.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-ID': request.id,
      ...sseCorsHeaders(request.headers.origin, parseCorsOrigins(this.config.get('CORS_ORIGINS', { infer: true }))),
    });
    await this.sessions.stream(context, reply.raw, abort);
  }

  @Post('interrupt')
  async interrupt(@CurrentUser() user: AuthenticatedUser, @Body() input: InterruptRequestDto) {
    return ok({ request_id: await this.sessions.interrupt(user.id, input) });
  }

  @Post('detail')
  async detail(@CurrentUser() user: AuthenticatedUser, @Body() input: SessionDetailRequestDto) {
    return ok(await this.sessions.detail(user.id, input));
  }

  @Post('history')
  async history(@CurrentUser() user: AuthenticatedUser, @Body() input: SessionHistoryRequestDto) {
    return ok(await this.sessions.history(user.id, input));
  }

  @Post('rate-answer')
  async rate(@CurrentUser() user: AuthenticatedUser, @Body() input: RateAnswerRequestDto) {
    return ok(await this.sessions.rate(user.id, input));
  }
}

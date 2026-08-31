import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { fail } from './api-response';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const status = this.status(exception);
    const payload = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message = status >= 500 ? 'Internal server error' : this.extractMessage(exception, payload);
    const errors = this.extractErrors(payload);

    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.message : message,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    response.status(status).send(fail(message, status, errors ? { errors } : null));
  }

  private status(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    const postgresCode = (exception as { code?: unknown } | null)?.code;
    if (postgresCode === '23505' || postgresCode === '23503') return HttpStatus.CONFLICT;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private extractMessage(exception: unknown, payload: string | object | undefined): string {
    if (typeof payload === 'string') return payload;
    if (payload && 'message' in payload) {
      const message = (payload as { message?: string | string[] }).message;
      return Array.isArray(message) ? message[0] || 'Invalid request' : message || 'Invalid request';
    }
    const postgresCode = (exception as { code?: unknown } | null)?.code;
    if (postgresCode === '23505') return 'Resource already exists';
    if (postgresCode === '23503') return 'Resource is still in use';
    return exception instanceof Error ? exception.message : 'Invalid request';
  }

  private extractErrors(payload: string | object | undefined): string[] | undefined {
    if (!payload || typeof payload === 'string' || !('message' in payload)) return undefined;
    const message = (payload as { message?: string | string[] }).message;
    return Array.isArray(message) ? message : undefined;
  }
}

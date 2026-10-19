import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { ApiException, type ErrorPayload } from './api-exception.js';
import { getRequestId } from './request-id.js';

const publicErrors: Record<number, ErrorPayload> = {
  400: { code: 'BAD_REQUEST', message: '请求格式不正确' },
  401: { code: 'UNAUTHORIZED', message: '请先登录' },
  403: { code: 'FORBIDDEN', message: '没有访问权限' },
  404: { code: 'NOT_FOUND', message: '接口不存在' },
  405: { code: 'METHOD_NOT_ALLOWED', message: '请求方法不支持' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: '请求内容超过大小限制' },
  429: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' },
  503: { code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用' },
};

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const requestId = getRequestId(request, response);
    let status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    // Body parser errors occur before controllers and are not HttpExceptions.
    if (exception && typeof exception === 'object' && 'type' in exception) {
      if (exception.type === 'entity.too.large') status = 413;
      if (exception.type === 'entity.parse.failed') status = 400;
    }
    const error =
      exception instanceof ApiException
        ? exception.payload
        : (publicErrors[status] ?? {
            code: 'INTERNAL_ERROR',
            message: '服务暂时不可用，请稍后重试',
          });
    if (status >= 500) {
      // Exception messages/stacks may contain upstream credentials or book text.
      this.logger.error({
        event: 'request_failed',
        code: error.code,
        requestId,
      });
    }
    if (!response.headersSent) {
      response.status(status).json({ error, meta: { requestId } });
    }
  }
}

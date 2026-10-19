import type { Options } from 'pino-http';
import type { Request, Response } from 'express';
import type { AppConfig } from '../../config/app-config.module.js';
import { getRequestId } from '../http/request-id.js';

export function createLoggerOptions(
  config: AppConfig,
): Options<Request, Response> {
  return {
    level: config.get('LOG_LEVEL'),
    base: { service: 'epub-ai-backend' },
    quietReqLogger: true,
    wrapSerializers: false,
    genReqId: (request, response) => getRequestId(request, response),
    serializers: {
      req: (request: Request) => ({ id: request.id, method: request.method }),
      res: (response: Response) => ({ statusCode: response.statusCode }),
      err: () => ({ type: 'Error' }),
    },
    redact: {
      paths: [
        'req.headers',
        'req.body',
        'res.headers',
        'headers',
        'body',
        'authorization',
        'cookie',
        'password',
        'apiKey',
        'token',
        'DATABASE_URL',
        'REDIS_URL',
        'QWEN_API_KEY',
      ],
      censor: '[REDACTED]',
    },
    customLogLevel: (_request, response, error) =>
      error || response.statusCode >= 500
        ? 'error'
        : response.statusCode >= 400
          ? 'warn'
          : 'info',
    customSuccessMessage: () => 'request_completed',
    customErrorMessage: () => 'request_failed',
    ...(config.get('LOG_PRETTY')
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  };
}

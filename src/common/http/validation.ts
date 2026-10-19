import {
  HttpStatus,
  type ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { ApiException } from './api-exception.js';

function summarize(errors: ValidationError[], prefix = ''): unknown[] {
  return errors.flatMap((error) => {
    const field = `${prefix}${error.property}`;
    return [
      ...(error.constraints
        ? [{ field, rules: Object.keys(error.constraints) }]
        : []),
      ...summarize(error.children ?? [], `${field}.`),
    ];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new ApiException(
        {
          code: 'VALIDATION_ERROR',
          message: '请求参数校验失败',
          details: summarize(errors),
        },
        HttpStatus.BAD_REQUEST,
      ),
  });
}

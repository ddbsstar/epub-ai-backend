import { HttpException, HttpStatus } from '@nestjs/common';

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

/** Only use messages/details that are safe to return to an API client. */
export class ApiException extends HttpException {
  constructor(
    readonly payload: ErrorPayload,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(payload, status);
  }
}

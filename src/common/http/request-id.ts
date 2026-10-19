import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const safeRequestId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const supplied = request.headers['x-request-id'];
  request.id =
    typeof supplied === 'string' && safeRequestId.test(supplied)
      ? supplied
      : randomUUID();
  if (!response.headersSent) response.setHeader('x-request-id', request.id);
  next();
}

export function getRequestId(request: Request, response: Response): string {
  if (typeof request.id !== 'string' || !safeRequestId.test(request.id)) {
    request.id = randomUUID();
  }
  if (!response.headersSent) response.setHeader('x-request-id', request.id);
  return request.id;
}

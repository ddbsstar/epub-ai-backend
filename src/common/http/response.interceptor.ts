import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import { getRequestId } from './request-id.js';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const requestId = getRequestId(
      http.getRequest<Request>(),
      http.getResponse<Response>(),
    );
    return next
      .handle()
      .pipe(map((data: unknown) => ({ data, meta: { requestId } })));
  }
}

import { randomBytes, createHash } from 'node:crypto';
import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfig } from '../config/app-config.module.js';
import { businessError } from './business-errors.js';

export interface BusinessRequest extends Request {
  processingOwnerId: string;
}

const COOKIE = 'epub_local_session';
const BETA_COOKIE = '__Host-epub_beta_session';

@Injectable()
export class BusinessAccessGuard implements CanActivate {
  constructor(@Inject(AppConfig) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.get('PROCESSING_ENABLED'))
      throw businessError('PROCESSING_DISABLED', 503);
    const request = context.switchToHttp().getRequest<BusinessRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const remote = request.socket.remoteAddress;
    const beta = this.config.get('PROCESSING_PUBLIC_BETA_ENABLED');
    if (
      (this.config.get('NODE_ENV') === 'production' && !beta) ||
      !remote ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
    ) {
      throw businessError('LOCAL_ACCESS_ONLY', 403);
    }
    if (beta) return this.publicBeta(request, response);
    // A loopback TCP peer alone does not prevent browser DNS rebinding.
    // Accept only literal loopback/localhost authorities, before using Host for Origin.
    const host = request.headers.host;
    const authority =
      typeof host === 'string'
        ? /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host)
        : null;
    if (
      !authority ||
      (authority[1] &&
        (Number(authority[1]) < 1 || Number(authority[1]) > 65535))
    ) {
      throw businessError('LOCAL_ACCESS_ONLY', 403);
    }
    const origin = request.headers.origin;
    if (
      origin &&
      origin !== this.config.get('PROCESSING_ALLOWED_ORIGIN') &&
      origin !== `http://${host}`
    ) {
      throw businessError('INVALID_ORIGIN', 403);
    }
    const token = request.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const session =
      token && /^[a-f0-9]{64}$/.test(token)
        ? token
        : randomBytes(32).toString('hex');
    request.processingOwnerId = createHash('sha256')
      .update(session)
      .digest('hex');
    if (session !== token)
      response.appendHeader(
        'Set-Cookie',
        `${COOKIE}=${session}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=1209600`,
      );
    response.setHeader('Cache-Control', 'no-store');
    return true;
  }

  private publicBeta(request: BusinessRequest, response: Response): boolean {
    const expected = new URL(this.config.get('PROCESSING_ALLOWED_ORIGIN'));
    if (
      request.headers.host !== expected.host ||
      request.headers['x-forwarded-proto'] !== 'https'
    )
      throw businessError('INVALID_ORIGIN', 403);
    const origin = request.headers.origin;
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (
      (mutation && origin !== expected.origin) ||
      (origin && origin !== expected.origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    )
      throw businessError('INVALID_ORIGIN', 403);
    const path = request.path;
    if (
      !/^\/api\/v1\/(?:uploads|capabilities|feedback|books\/[a-f0-9-]{36}\/exports|runs\/[a-f0-9-]{36}(?:\/cancel)?|artifacts\/[a-f0-9-]{36}\/download)$/.test(
        path,
      )
    )
      throw businessError('PROCESSING_DISABLED', 404);
    const tokens =
      request.headers.cookie
        ?.split(';')
        .map((item) => item.trim())
        .filter((item) => item.startsWith(BETA_COOKIE + '=')) ?? [];
    const token =
      tokens.length === 1
        ? tokens[0]!.slice(BETA_COOKIE.length + 1)
        : undefined;
    const session =
      token && /^[a-f0-9]{64}$/.test(token)
        ? token
        : randomBytes(32).toString('hex');
    request.processingOwnerId = createHash('sha256')
      .update(session)
      .digest('hex');
    if (session !== token)
      response.appendHeader(
        'Set-Cookie',
        `${BETA_COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${this.config.get('PROCESSING_BETA_RETENTION_HOURS') * 3600}`,
      );
    response.setHeader('Cache-Control', 'private, no-store');
    return true;
  }
}

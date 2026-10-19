import { isIP } from 'node:net';
import { z } from 'zod';

const bool = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);
const integer = (minimum: number, maximum: number) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
    z.number().int().min(minimum).max(maximum),
  );
const optionalString = z.string().trim().default('');

function validUrl(value: string, protocols: string[]): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

const schema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z
      .string()
      .refine((value) => isIP(value) !== 0 || value === 'localhost')
      .default('127.0.0.1'),
    PORT: integer(1, 65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: bool.default(false),
    JSON_BODY_LIMIT_KB: integer(1, 1024).default(256),
    SWAGGER_ENABLED: bool.default(true),
    THROTTLE_TTL_MS: integer(1000, 3600000).default(60000),
    THROTTLE_LIMIT: integer(1, 10000).default(300),
    DATABASE_ENABLED: bool.default(false),
    DATABASE_URL: optionalString.refine((value) => validUrl(value, ['mysql:'])),
    DB_CONNECTION_LIMIT: integer(1, 20).default(5),
    REDIS_ENABLED: bool.default(false),
    REDIS_URL: optionalString.refine((value) =>
      validUrl(value, ['redis:', 'rediss:']),
    ),
    QUEUE_ENABLED: bool.default(false),
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .default('epub-ai'),
    QWEN_ENABLED: bool.default(false),
    QWEN_API_KEY: optionalString,
    QWEN_BASE_URL: optionalString.refine((value) =>
      validUrl(value, ['http:', 'https:']),
    ),
    QWEN_MODEL: optionalString,
    QWEN_TIMEOUT_MS: integer(1000, 120000).default(30000),
    QWEN_MAX_OUTPUT_TOKENS: integer(1, 8192).default(2048),
  })
  .superRefine((env, context) => {
    const required = (key: keyof typeof env, condition: boolean) => {
      if (condition && !env[key]) {
        context.addIssue({ code: 'custom', path: [key], message: 'Required' });
      }
    };
    required('DATABASE_URL', env.DATABASE_ENABLED);
    required('REDIS_URL', env.REDIS_ENABLED);
    required('REDIS_ENABLED', env.QUEUE_ENABLED);
    required('QWEN_API_KEY', env.QWEN_ENABLED);
    required('QWEN_BASE_URL', env.QWEN_ENABLED);
    required('QWEN_MODEL', env.QWEN_ENABLED);
    if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
      context.addIssue({
        code: 'custom',
        path: ['LOG_PRETTY'],
        message: 'Disabled in production',
      });
    }
    if (env.QWEN_BASE_URL && validUrl(env.QWEN_BASE_URL, ['http:', 'https:'])) {
      const url = new URL(env.QWEN_BASE_URL);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
        url.hostname,
      );
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== 'https:' &&
          !(loopback && env.NODE_ENV !== 'production'))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['QWEN_BASE_URL'],
          message: 'Invalid endpoint',
        });
      }
    }
  });

export type Environment = z.infer<typeof schema>;

export class ConfigurationError extends Error {
  constructor(fields: string[]) {
    super(`Invalid environment configuration: ${fields.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

export function validateEnvironment(
  input: Record<string, unknown>,
): Environment {
  const normalized = {
    ...input,
    SWAGGER_ENABLED: input.SWAGGER_ENABLED ?? input.NODE_ENV !== 'production',
    THROTTLE_LIMIT:
      input.THROTTLE_LIMIT ?? (input.NODE_ENV === 'production' ? 120 : 300),
  };
  const result = schema.safeParse(normalized);
  if (!result.success) {
    // Zod error text may contain supplied values; report field names only.
    throw new ConfigurationError([
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ]);
  }
  return result.data;
}

import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
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
    // Internal visual gate uses the same explicitly configured Qwen endpoint/key.
    VISUAL_REVIEW_ENABLED: bool.default(false),
    VISUAL_REVIEW_MODEL: z.string().trim().max(128).default(''),
    VISUAL_REVIEW_MAX_OUTPUT_TOKENS: integer(256, 4096).default(1024),
    VISUAL_REVIEW_INPUT_TOKEN_BUDGET: integer(8192, 32768).default(32768),
    VISUAL_REVIEW_INPUT_PRICE_MICROS_PER_MILLION: integer(1, 100000000).default(
      800000,
    ),
    VISUAL_REVIEW_OUTPUT_PRICE_MICROS_PER_MILLION: integer(
      1,
      100000000,
    ).default(2700000),
    VISUAL_REVIEW_PRICE_VERSION: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}$/)
      .default('qwen-visual-configured-v1'),
    // Independent internal image API; never enabled by the text-model flag.
    IMAGE_GENERATION_ENABLED: bool.default(false),
    IMAGE_API_KEY: optionalString,
    IMAGE_API_BASE_URL: z
      .literal('https://maas.qianwenaiapi.com/api/v1')
      .default('https://maas.qianwenaiapi.com/api/v1'),
    IMAGE_MODEL: z.literal('z-image-turbo').default('z-image-turbo'),
    IMAGE_SIZE: z.literal('1024*1024').default('1024*1024'),
    IMAGE_TIMEOUT_MS: integer(1000, 180000).default(120000),
    IMAGE_DATA_DIR: optionalString,
    IMAGE_DOWNLOAD_HOSTS: z
      .string()
      .max(1000)
      .refine((value) => {
        const hosts = value.split(',');
        return (
          hosts.length > 0 &&
          hosts.length <= 10 &&
          hosts.every((host) =>
            /^(?!.*\.\.)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(
              host,
            ),
          )
        );
      })
      .default(
        'dashscope-result-bj.oss-cn-beijing.aliyuncs.com,dashscope-result-sh.oss-cn-shanghai.aliyuncs.com,dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com,dashscope-a717.oss-accelerate.aliyuncs.com',
      ),
    IMAGE_MAX_BYTES: integer(1024, 20971520).default(10485760),
    IMAGE_MAX_PIXELS: integer(1, 16777216).default(16777216),
    IMAGE_PRICE_MICROS: integer(1, 10000000).default(100000),
    IMAGE_OPERATION_BUDGET_MICROS: integer(1, 10000000).default(100000),
    IMAGE_DAILY_BUDGET_MICROS: integer(1, 1000000000).default(1000000),
    IMAGE_PRICE_VERSION: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}$/)
      .default('qianwen-platform-z-image-turbo-2026-10-21'),
    ILLUSTRATION_BATCH_BUDGET_MICROS: integer(1, 1000000000).default(1000000),
    PROCESSING_ENABLED: bool.default(false),
    PROCESSING_PUBLIC_BETA_ENABLED: bool.default(false),
    PROCESSING_FEEDBACK_ENABLED: bool.default(false),
    PROCESSING_BETA_OWNER_BOOK_LIMIT: integer(1, 20).default(5),
    PROCESSING_BETA_MAX_ACTIVE_RUNS: integer(1, 20).default(10),
    PROCESSING_BETA_STORAGE_MAX_MIB: integer(256, 4096).default(1024),
    PROCESSING_BETA_RETENTION_HOURS: integer(1, 72).default(24),
    PROCESSING_AI_ENABLED: bool.default(false),
    AI_INPUT_TOKEN_BUDGET: integer(1024, 32768).default(32768),
    AI_MAX_MESSAGE_BYTES: integer(1024, 24576).default(24576),
    AI_MAX_RESPONSE_BYTES: integer(1024, 98304).default(98304),
    AI_RUN_BUDGET_MICROS: integer(1, 10000000).default(50000),
    AI_DAILY_BUDGET_MICROS: integer(1, 1000000000).default(1000000),
    // Disables monetary admission only; accounting and dispatch fences remain.
    BUDGET_LIMITS_ENABLED: bool.default(true),
    AI_INPUT_PRICE_MICROS_PER_MILLION: integer(1, 100000000).default(800000),
    AI_OUTPUT_PRICE_MICROS_PER_MILLION: integer(1, 100000000).default(2700000),
    AI_PRICE_VERSION: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,100}$/)
      .default('qwen3.8-flash-cn-2026-10-21'),
    PROCESSING_REPOSITORY: z.enum(['local', 'mysql']).default('local'),
    PROCESSING_DATA_DIR: optionalString,
    PROCESSING_ALLOWED_ORIGIN: z.url().default('http://127.0.0.1:5173'),
    PROCESSING_UPLOAD_MAX_MIB: integer(1, 100).default(100),
    PROCESSING_POLL_MS: integer(100, 10000).default(1000),
    PROCESSING_LEASE_MS: integer(5000, 120000).default(30000),
    PROCESSING_OWNER_ACTIVE_LIMIT: integer(1, 10).default(1),
    PROCESSING_MAX_RUNS: integer(10, 10000).default(1000),
    EPUBCHECK_JAR_PATH: optionalString,
    EPUBCHECK_JAVA_PATH: z.string().min(1).default('java'),
    EPUBCHECK_TIMEOUT_MS: integer(1000, 180000).default(60000),
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
    if (env.VISUAL_REVIEW_ENABLED) {
      required('QWEN_ENABLED', true);
      required('PROCESSING_AI_ENABLED', true);
      if (
        env.VISUAL_REVIEW_MODEL &&
        !/^[a-zA-Z0-9._-]{1,128}$/.test(env.VISUAL_REVIEW_MODEL)
      )
        context.addIssue({
          code: 'custom',
          path: ['VISUAL_REVIEW_MODEL'],
          message: 'Model identifier required',
        });
    }
    if (env.IMAGE_GENERATION_ENABLED) {
      required('IMAGE_API_KEY', true);
      required('IMAGE_DATA_DIR', true);
      if (!isAbsolute(env.IMAGE_DATA_DIR))
        context.addIssue({
          code: 'custom',
          path: ['IMAGE_DATA_DIR'],
          message: 'Absolute private directory required',
        });
      if (
        env.NODE_ENV === 'production' ||
        !['localhost', '127.0.0.1', '::1'].includes(env.HOST)
      )
        context.addIssue({
          code: 'custom',
          path: ['IMAGE_GENERATION_ENABLED'],
          message: 'Internal local integration only',
        });
      if (
        env.BUDGET_LIMITS_ENABLED &&
        (env.IMAGE_PRICE_MICROS > env.IMAGE_OPERATION_BUDGET_MICROS ||
          env.IMAGE_OPERATION_BUDGET_MICROS > env.IMAGE_DAILY_BUDGET_MICROS)
      )
        context.addIssue({
          code: 'custom',
          path: ['IMAGE_OPERATION_BUDGET_MICROS'],
          message: 'Budgets must cover the configured image price',
        });
    }
    if (env.PROCESSING_AI_ENABLED) {
      required('PROCESSING_ENABLED', true);
      required('QWEN_ENABLED', true);
      if (
        env.BUDGET_LIMITS_ENABLED &&
        env.AI_RUN_BUDGET_MICROS > env.AI_DAILY_BUDGET_MICROS
      ) {
        context.addIssue({
          code: 'custom',
          path: ['AI_DAILY_BUDGET_MICROS'],
          message: 'Daily budget must cover one run budget',
        });
      }
    }
    if (env.PROCESSING_ENABLED) {
      required('PROCESSING_DATA_DIR', true);
      if (!isAbsolute(env.PROCESSING_DATA_DIR)) {
        context.addIssue({
          code: 'custom',
          path: ['PROCESSING_DATA_DIR'],
          message: 'Absolute directory required',
        });
      }
      required('EPUBCHECK_JAR_PATH', true);
      if (!isAbsolute(env.EPUBCHECK_JAR_PATH)) {
        context.addIssue({
          code: 'custom',
          path: ['EPUBCHECK_JAR_PATH'],
          message: 'Absolute file required',
        });
      }
      if (
        (env.NODE_ENV === 'production' &&
          !env.PROCESSING_PUBLIC_BETA_ENABLED) ||
        !['localhost', '127.0.0.1', '::1'].includes(env.HOST)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['PROCESSING_ENABLED'],
          message: 'Local development only until account integration',
        });
      }
      if (env.PROCESSING_REPOSITORY === 'mysql') {
        required('DATABASE_ENABLED', true);
        required('QUEUE_ENABLED', true);
      }
    }
    if (
      env.PROCESSING_FEEDBACK_ENABLED &&
      (!env.PROCESSING_ENABLED || env.PROCESSING_REPOSITORY !== 'local')
    )
      context.addIssue({
        code: 'custom',
        path: ['PROCESSING_FEEDBACK_ENABLED'],
        message:
          'Feedback requires enabled processing with the local private storage adapter',
      });
    if (env.PROCESSING_PUBLIC_BETA_ENABLED) {
      if (
        env.NODE_ENV !== 'production' ||
        !env.PROCESSING_ENABLED ||
        env.PROCESSING_REPOSITORY !== 'local' ||
        env.PROCESSING_AI_ENABLED ||
        env.QWEN_ENABLED ||
        env.IMAGE_GENERATION_ENABLED ||
        env.VISUAL_REVIEW_ENABLED ||
        env.PROCESSING_UPLOAD_MAX_MIB > 20 ||
        !env.PROCESSING_ALLOWED_ORIGIN.startsWith('https://')
      )
        context.addIssue({
          code: 'custom',
          path: ['PROCESSING_PUBLIC_BETA_ENABLED'],
          message: 'Dedicated HTTPS deterministic beta configuration required',
        });
    }
    if (validUrl(env.PROCESSING_ALLOWED_ORIGIN, ['http:', 'https:'])) {
      const origin = new URL(env.PROCESSING_ALLOWED_ORIGIN);
      if (
        !['http:', 'https:'].includes(origin.protocol) ||
        origin.origin !== env.PROCESSING_ALLOWED_ORIGIN ||
        origin.username ||
        origin.password
      ) {
        context.addIssue({
          code: 'custom',
          path: ['PROCESSING_ALLOWED_ORIGIN'],
          message: 'Origin required',
        });
      }
    }
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

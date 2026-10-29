import { validateEnvironment } from '../src/config/environment.js';

describe('Environment boundary', () => {
  it('admits only a dedicated HTTPS deterministic loopback beta and rejects accidental paid or public-listener configuration', () => {
    const profile = {
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PROCESSING_ENABLED: true,
      PROCESSING_PUBLIC_BETA_ENABLED: true,
      PROCESSING_REPOSITORY: 'local',
      PROCESSING_DATA_DIR: 'C:/private/epub-test-data',
      EPUBCHECK_JAR_PATH: 'C:/tools/checker.jar',
      PROCESSING_ALLOWED_ORIGIN: 'https://epub.example.test',
      PROCESSING_UPLOAD_MAX_MIB: 20,
    };
    expect(validateEnvironment(profile).PROCESSING_BETA_RETENTION_HOURS).toBe(
      24,
    );
    for (const change of [
      { HOST: '0.0.0.0' },
      { NODE_ENV: 'development' },
      { PROCESSING_AI_ENABLED: true },
      { QWEN_ENABLED: true },
      { PROCESSING_REPOSITORY: 'mysql' },
      { PROCESSING_ALLOWED_ORIGIN: 'http://epub.example.test' },
      { PROCESSING_UPLOAD_MAX_MIB: 100 },
    ])
      expect(() => validateEnvironment({ ...profile, ...change })).toThrow(
        'Invalid environment configuration',
      );
  });
  it('parses false explicitly and uses production defaults', () => {
    const config = validateEnvironment({
      NODE_ENV: 'production',
      DATABASE_ENABLED: 'false',
    });
    expect(config.DATABASE_ENABLED).toBe(false);
    expect(config.SWAGGER_ENABLED).toBe(false);
    expect(config.LOG_PRETTY).toBe(false);
  });

  it.each([
    { PORT: '0' },
    { DATABASE_ENABLED: 'yes' },
    { DATABASE_ENABLED: true },
    { QUEUE_ENABLED: true },
    { QWEN_ENABLED: true },
    { IMAGE_GENERATION_ENABLED: true },
    { IMAGE_API_BASE_URL: 'https://private-marker.example/api/v1' },
    { IMAGE_MODEL: 'unpriced-model' },
    { IMAGE_SIZE: '2048*2048' },
    { IMAGE_DOWNLOAD_HOSTS: '*.example.com' },
    { IMAGE_DOWNLOAD_HOSTS: 'localhost' },
    { IMAGE_PRICE_MICROS: 0 },
    { BUDGET_LIMITS_ENABLED: 'yes' },
    { BUDGET_LIMITS_ENABLED: false, AI_DAILY_BUDGET_MICROS: 0 },
    { BUDGET_LIMITS_ENABLED: false, IMAGE_PRICE_MICROS: 0 },
    { PROCESSING_AI_ENABLED: true },
    { AI_INPUT_TOKEN_BUDGET: 100000 },
    { AI_DAILY_BUDGET_MICROS: 0 },
    { AI_PRICE_VERSION: 'private-marker/invalid' },
    { QWEN_BASE_URL: 'https://user:private-marker@example.com/v1' },
    { PROCESSING_ALLOWED_ORIGIN: 'not-a-url' },
    { PROCESSING_ENABLED: true },
    {
      NODE_ENV: 'production',
      PROCESSING_ENABLED: true,
      PROCESSING_DATA_DIR: 'C:/private/local-data',
      EPUBCHECK_JAR_PATH: 'C:/tools/checker.jar',
    },
  ])('rejects invalid configuration without exposing its values', (input) => {
    expect(() => validateEnvironment(input)).toThrow(
      'Invalid environment configuration:',
    );
    try {
      validateEnvironment(input);
    } catch (error) {
      expect(String(error)).not.toContain('private-marker');
    }
  });

  it('keeps AI business calls opt-in and validates an enabled local profile', () => {
    expect(validateEnvironment({}).PROCESSING_AI_ENABLED).toBe(false);
    const profile = {
      NODE_ENV: 'test',
      PROCESSING_ENABLED: true,
      PROCESSING_AI_ENABLED: true,
      PROCESSING_DATA_DIR: 'C:/private/epub-test-data',
      EPUBCHECK_JAR_PATH: 'C:/tools/checker.jar',
      QWEN_ENABLED: true,
      QWEN_API_KEY: 'test-placeholder',
      QWEN_BASE_URL: 'https://example.com/v1',
      QWEN_MODEL: 'test-model',
    };
    expect(validateEnvironment(profile).AI_RUN_BUDGET_MICROS).toBe(50000);
    expect(() =>
      validateEnvironment({ ...profile, AI_DAILY_BUDGET_MICROS: 1 }),
    ).toThrow('AI_DAILY_BUDGET_MICROS');
  });

  it('keeps images independent and validates price, private storage and local use', () => {
    expect(validateEnvironment({}).IMAGE_GENERATION_ENABLED).toBe(false);
    const profile = {
      NODE_ENV: 'test',
      IMAGE_GENERATION_ENABLED: true,
      IMAGE_API_KEY: 'test-placeholder',
      IMAGE_DATA_DIR: 'C:/private/image-test-data',
    };
    expect(validateEnvironment(profile).IMAGE_PRICE_MICROS).toBe(100000);
    expect(() =>
      validateEnvironment({ ...profile, NODE_ENV: 'production' }),
    ).toThrow('IMAGE_GENERATION_ENABLED');
    expect(() =>
      validateEnvironment({ ...profile, IMAGE_DATA_DIR: 'relative' }),
    ).toThrow('IMAGE_DATA_DIR');
    expect(() =>
      validateEnvironment({ ...profile, IMAGE_OPERATION_BUDGET_MICROS: 1 }),
    ).toThrow('IMAGE_OPERATION_BUDGET_MICROS');
  });

  it('only removes monetary admission when explicitly disabled, retaining price snapshots and infrastructure requirements', () => {
    expect(validateEnvironment({}).BUDGET_LIMITS_ENABLED).toBe(true);
    const profile = {
      NODE_ENV: 'test',
      PROCESSING_ENABLED: true,
      PROCESSING_AI_ENABLED: true,
      PROCESSING_DATA_DIR: 'C:/private/epub-test-data',
      EPUBCHECK_JAR_PATH: 'C:/tools/checker.jar',
      QWEN_ENABLED: true,
      QWEN_API_KEY: 'test-placeholder',
      QWEN_BASE_URL: 'https://example.com/v1',
      QWEN_MODEL: 'test-model',
      IMAGE_GENERATION_ENABLED: true,
      IMAGE_API_KEY: 'test-placeholder',
      IMAGE_DATA_DIR: 'C:/private/image-test-data',
      AI_RUN_BUDGET_MICROS: 100,
      AI_DAILY_BUDGET_MICROS: 1,
      IMAGE_OPERATION_BUDGET_MICROS: 1,
      IMAGE_DAILY_BUDGET_MICROS: 1,
    };
    expect(() => validateEnvironment(profile)).toThrow(
      'Invalid environment configuration:',
    );
    const unlimited = validateEnvironment({
      ...profile,
      BUDGET_LIMITS_ENABLED: 'false',
    });
    expect(unlimited.BUDGET_LIMITS_ENABLED).toBe(false);
    expect(unlimited.AI_DAILY_BUDGET_MICROS).toBe(1);
    expect(unlimited.IMAGE_PRICE_MICROS).toBe(100000);
    expect(unlimited.AI_INPUT_PRICE_MICROS_PER_MILLION).toBe(800000);
    expect(() =>
      validateEnvironment({
        ...profile,
        BUDGET_LIMITS_ENABLED: false,
        QWEN_API_KEY: '',
      }),
    ).toThrow('QWEN_API_KEY');
    expect(() =>
      validateEnvironment({
        ...profile,
        BUDGET_LIMITS_ENABLED: false,
        NODE_ENV: 'production',
      }),
    ).toThrow('IMAGE_GENERATION_ENABLED');
  });
});

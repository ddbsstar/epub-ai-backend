import { validateEnvironment } from '../src/config/environment.js';

describe('Environment boundary', () => {
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
    { QWEN_BASE_URL: 'https://user:private-marker@example.com/v1' },
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
});

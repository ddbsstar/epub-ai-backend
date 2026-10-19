import { Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ConfigurationStatus = 'not_configured' | 'configured_not_checked';

@Controller('health')
export class HealthController {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  @Get()
  getHealth() {
    return {
      status: 'ok',
      service: 'epub-ai-backend',
      dependencies: {
        database: this.configurationStatus([
          'MYSQL_HOST',
          'MYSQL_USER',
          'MYSQL_DATABASE',
        ]),
        qwen: this.configurationStatus([
          'QWEN_API_KEY',
          'QWEN_BASE_URL',
          'QWEN_MODEL',
        ]),
      },
    };
  }

  private configurationStatus(keys: string[]): ConfigurationStatus {
    return keys.every((key) => Boolean(this.config.get<string>(key)?.trim()))
      ? 'configured_not_checked'
      : 'not_configured';
  }
}

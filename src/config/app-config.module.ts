import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateEnvironment, type Environment } from './environment.js';

@Injectable()
export class AppConfig {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  get<K extends keyof Environment>(key: K): Environment[K] {
    return this.config.get<Environment[K]>(key) as Environment[K];
  }
}

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validate: validateEnvironment,
    }),
  ],
  providers: [AppConfig],
  exports: [AppConfig],
})
export class AppConfigModule {}

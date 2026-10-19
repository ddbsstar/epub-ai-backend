import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig } from 'prisma/config';

if (existsSync('.env')) loadEnvFile('.env');

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Generation/validation never connect. Migration scripts reject missing URL.
    url:
      process.env.DATABASE_URL ||
      'mysql://unconfigured:unconfigured@127.0.0.1:1/unconfigured',
  },
});

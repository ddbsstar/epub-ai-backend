import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

if (existsSync('.env')) loadEnvFile('.env');
try {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.protocol !== 'mysql:' || !url.hostname || url.pathname.length < 2) {
    throw new Error('Invalid URL');
  }
} catch {
  console.error(
    'Set a valid DATABASE_URL before running a database migration.',
  );
  process.exitCode = 1;
}

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const [mode, ...pairs] = process.argv.slice(2);
const allowed = new Set(['--data-dir', '--epubcheck-jar', '--java', '--ai']);
const options = new Map();
for (let index = 0; index < pairs.length; index += 2) {
  if (
    !allowed.has(pairs[index]) ||
    !pairs[index + 1] ||
    options.has(pairs[index])
  ) {
    throw new Error(
      'Use: api|worker --data-dir <absolute directory> --epubcheck-jar <absolute jar> [--java <Java executable>] [--ai enabled|disabled]',
    );
  }
  options.set(pairs[index], pairs[index + 1]);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 15))
  throw new Error('Node.js >=24.15 is required');
if (
  !['api', 'worker'].includes(mode) ||
  !['enabled', 'disabled'].includes(options.get('--ai') ?? 'disabled') ||
  !isAbsolute(options.get('--data-dir') ?? '') ||
  !isAbsolute(options.get('--epubcheck-jar') ?? '')
) {
  throw new Error(
    'Use: api|worker --data-dir <absolute directory> --epubcheck-jar <absolute jar> [--java <Java executable>] [--ai enabled|disabled]',
  );
}
const entry = resolve('dist', mode === 'api' ? 'main.js' : 'main-worker.js');
await access(entry).catch(() => {
  throw new Error('Run npm run build before starting');
});
await access(options.get('--epubcheck-jar')).catch(() => {
  throw new Error('EPUBCheck jar is unavailable');
});
const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: process.env.PORT ?? '3000',
    DATABASE_ENABLED: 'false',
    REDIS_ENABLED: 'false',
    QUEUE_ENABLED: 'false',
    QWEN_ENABLED: options.get('--ai') === 'enabled' ? 'true' : 'false',
    PROCESSING_AI_ENABLED: options.get('--ai') === 'enabled' ? 'true' : 'false',
    PROCESSING_ENABLED: 'true',
    PROCESSING_REPOSITORY: 'local',
    PROCESSING_DATA_DIR: resolve(options.get('--data-dir')),
    EPUBCHECK_JAR_PATH: resolve(options.get('--epubcheck-jar')),
    EPUBCHECK_JAVA_PATH: options.get('--java') ?? 'java',
  },
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    child.kill(signal);
  });
child.once('error', () => {
  process.stderr.write('Local processing failed to start\n');
  process.exitCode = 1;
});
child.once('exit', (code) => {
  process.exitCode = code ?? 1;
});

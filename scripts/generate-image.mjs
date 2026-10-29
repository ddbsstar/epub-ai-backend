import 'reflect-metadata';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { NestFactory } from '@nestjs/core';

// Prompt/key contents are never command-line arguments or log messages.
let application;
try {
  const [flag, requestPath, ...rest] = process.argv.slice(2);
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (
    major < 24 ||
    (major === 24 && minor < 15) ||
    flag !== '--request' ||
    !requestPath ||
    !isAbsolute(requestPath) ||
    rest.length
  )
    throw Object.assign(new Error(), { code: 'IMAGE_CLI_INVALID_ARGUMENTS' });
  const info = await stat(requestPath);
  if (!info.isFile() || info.size > 16384)
    throw Object.assign(new Error(), { code: 'IMAGE_CLI_INVALID_REQUEST' });
  const input = JSON.parse(await readFile(requestPath, 'utf8'));
  const { ImageGenerationModule } =
    await import('../dist/ai/image-generation.module.js');
  const { ImageGenerationService } =
    await import('../dist/ai/image-generation.service.js');
  application = await NestFactory.createApplicationContext(
    ImageGenerationModule,
    {
      logger: false,
      abortOnError: false,
    },
  );
  const cancellation = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'])
    process.once(name, () => cancellation.abort());
  const receipt = await application
    .get(ImageGenerationService)
    .generateOne(input, cancellation.signal);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
  const code =
    typeof error?.code === 'string' &&
    /^IMAGE_[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : 'IMAGE_CLI_FAILED';
  process.stderr.write(`${JSON.stringify({ error: { code } })}\n`);
  process.exitCode = 1;
} finally {
  await application?.close();
}

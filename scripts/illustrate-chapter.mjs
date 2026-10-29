import 'reflect-metadata';
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  stat,
  mkdtemp,
  link,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requestSchema = z
  .object({
    sourcePath: z.string().refine(isAbsolute),
    outputDirectory: z.string().refine(isAbsolute),
    textStateDirectory: z.string().refine(isAbsolute).optional(),
    chapterIndex: z.number().int().min(0).max(500),
    sectionId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    placementMode: z.literal('content-inline-v2').optional(),
    operationId: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
    recoverReceivedResponses: z.boolean().optional(),
    sceneDirection: z
      .string()
      .min(1)
      .refine((value) => Array.from(value).length <= 200)
      .optional(),
    // The imported registry performs the complete strict snapshot validation
    // before constructing a model application or admitting a paid call.
    artDirection: z.unknown().optional(),
    artDirectionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    bookArtPlanHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    planningPolicy: z.literal('content-people-1').optional(),
    imagePromptReview: z
      .object({
        sourcePlanHash: z.string().regex(/^[a-f0-9]{64}$/),
        prompt: z
          .string()
          .min(1)
          .refine((value) => Array.from(value).length <= 800),
        alt: z
          .string()
          .min(1)
          .refine((value) => Array.from(value).length <= 500),
        reason: z.string().min(1).max(500),
      })
      .strict()
      .optional(),
  })
  .strict();
async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function optionalJson(path) {
  try {
    return await json(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  const { atomicRename } = await import('../dist/processing/atomic-rename.js');
  await atomicRename(temporary, path);
}
const emit = (stage, status, details = {}) =>
  process.stdout.write(JSON.stringify({ stage, status, ...details }) + '\n');
let application;
let persistence;
const cancel = new AbortController();
const cancelFromParent = (message) => {
  if (message && typeof message === 'object' && message.type === 'cancel')
    cancel.abort();
};
process.on('message', cancelFromParent);
process.once('disconnect', () => cancel.abort());
for (const name of ['SIGINT', 'SIGTERM'])
  process.once(name, () => cancel.abort());
try {
  const args = process.argv.slice(2);
  if (
    args[0] !== '--request' ||
    !isAbsolute(args[1] ?? '') ||
    ![2, 4].includes(args.length) ||
    (args.length === 4 && args[2] !== '--until')
  )
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_CLI_ARGUMENTS' });
  const until = args[3] ?? 'export';
  if (!['plan', 'image', 'export', 'book-art'].includes(until))
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_CLI_ARGUMENTS' });
  if ((await stat(args[1])).size > 16384) throw new Error();
  const request = requestSchema.parse(await json(args[1]));
  if (
    (request.artDirection !== undefined) !==
    (request.artDirectionHash !== undefined)
  )
    throw Object.assign(new Error(), { code: 'ART_DIRECTION_INVALID' });
  if (
    (request.sectionId !== undefined) !==
    (request.placementMode === 'content-inline-v2')
  )
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_INVALID_SECTION' });
  const output = resolve(request.outputDirectory);
  if (resolve(request.sourcePath) === join(output, 'illustrated.epub'))
    throw new Error();
  await mkdir(join(output, 'private'), { recursive: true, mode: 0o700 });
  const [
    { ImageGenerationModule },
    { ImageGenerationService },
    { AppConfig },
    { AiService },
    { LocalProcessingPersistence },
    { ProcessingRepository },
    { inspectIllustrationChapter },
    { ChapterIllustrationPlanner },
    { insertEpubIllustration },
    { processEpub },
    { EpubCheckService, assertNoNewFormatErrors },
    { hashFile },
    { resolveArtDirection, artDirectionHash, assertArtDirectedPrompt },
    { buildBookArtEvidence, BookArtPlanner, bookArtPlanHash },
  ] = await Promise.all([
    import('../dist/ai/image-generation.module.js'),
    import('../dist/ai/image-generation.service.js'),
    import('../dist/config/app-config.module.js'),
    import('../dist/ai/ai.service.js'),
    import('../dist/processing/local-processing.persistence.js'),
    import('../dist/processing/processing.repository.js'),
    import('../dist/documents/chapter-illustration-index.js'),
    import('../dist/ai/chapter-illustration-planner.js'),
    import('../dist/documents/illustrated-epub.js'),
    import('../dist/documents/epub-engine.js'),
    import('../dist/business/epubcheck.service.js'),
    import('../dist/documents/epub-archive.js'),
    import('../dist/ai/illustration-art-direction.js'),
    import('../dist/ai/book-art-planner.js'),
  ]);
  const artDirection =
    request.artDirection === undefined
      ? undefined
      : resolveArtDirection(request.artDirection, request.artDirectionHash);
  const styleHash = artDirection ? artDirectionHash(artDirection) : undefined;
  if (
    request.planningPolicy &&
    (!request.sectionId ||
      artDirection?.id !== 'book-art' ||
      until === 'book-art')
  )
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_PLAN_INVALID' });
  const styleInput = artDirection
    ? {
        artDirection,
        artDirectionHash: styleHash,
        ...(request.planningPolicy
          ? { planningPolicy: request.planningPolicy }
          : {}),
      }
    : {};
  application = await NestFactory.createApplicationContext(
    ImageGenerationModule,
    { logger: false, abortOnError: false },
  );
  const config = application.get(AppConfig);
  if (!config.get('IMAGE_GENERATION_ENABLED') || !config.get('QWEN_ENABLED'))
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_MODELS_DISABLED' });
  const signal = cancel.signal;
  signal.throwIfAborted();
  emit('inspect', 'running');
  const bookArtEvidence =
    until === 'book-art'
      ? await buildBookArtEvidence({ sourcePath: request.sourcePath, signal })
      : undefined;
  const chapter =
    bookArtEvidence?.seedChapter ??
    (await inspectIllustrationChapter({
      sourcePath: request.sourcePath,
      chapterIndex: request.chapterIndex,
      ...(request.sectionId ? { sectionId: request.sectionId } : {}),
      signal,
    }));
  if (artDirection)
    resolveArtDirection(artDirection, styleHash, chapter.sourceSha256);
  if (
    bookArtEvidence &&
    (request.sectionId !== chapter.chapterId ||
      request.artDirection ||
      request.bookArtPlanHash ||
      request.imagePromptReview)
  )
    throw Object.assign(new Error(), { code: 'BOOK_ART_SOURCE_MISMATCH' });
  const ownerId = request.textStateDirectory
    ? `chapter-trial:${request.operationId}`
    : 'local-chapter-trial';
  const binding = {
    version: 1,
    sourceSha256: chapter.sourceSha256,
    chapterId: chapter.chapterId,
    operationId: request.operationId,
    ...(request.sectionId
      ? { sectionId: request.sectionId, placementMode: request.placementMode }
      : {}),
    ...(request.textStateDirectory ? { ownerNamespace: ownerId } : {}),
    ...styleInput,
    ...(request.bookArtPlanHash
      ? { bookArtPlanHash: request.bookArtPlanHash }
      : {}),
    configuration: digest({
      plannerCode: await hashFile(
        fileURLToPath(
          new URL(
            '../dist/ai/chapter-illustration-planner.js',
            import.meta.url,
          ),
        ),
        signal,
      ),
      text: [
        'QWEN_BASE_URL',
        'QWEN_MODEL',
        'QWEN_MAX_OUTPUT_TOKENS',
        'AI_INPUT_TOKEN_BUDGET',
        'AI_MAX_MESSAGE_BYTES',
        'AI_INPUT_PRICE_MICROS_PER_MILLION',
        'AI_OUTPUT_PRICE_MICROS_PER_MILLION',
        'AI_PRICE_VERSION',
      ].map((key) => [key, config.get(key)]),
      image: [
        'IMAGE_API_BASE_URL',
        'IMAGE_MODEL',
        'IMAGE_SIZE',
        'IMAGE_PRICE_MICROS',
        'IMAGE_PRICE_VERSION',
      ].map((key) => [key, config.get(key)]),
      ...(artDirection
        ? {
            artDirectionHash: styleHash,
            artDirectionPolicyCode: await hashFile(
              fileURLToPath(
                new URL(
                  '../dist/ai/illustration-art-direction.js',
                  import.meta.url,
                ),
              ),
              signal,
            ),
          }
        : {}),
      ...(until === 'book-art'
        ? {
            bookArtPolicyCode: await hashFile(
              fileURLToPath(
                new URL('../dist/ai/book-art-planner.js', import.meta.url),
              ),
              signal,
            ),
            bookArtEvidenceSha256: bookArtEvidence.snapshot.evidenceSha256,
          }
        : {}),
    }),
  };
  const statePath = join(output, 'private', 'binding.json');
  const previousBinding = await optionalJson(statePath);
  if (previousBinding && digest(previousBinding) !== digest(binding)) {
    await save(join(output, 'private', 'binding-conflict.json'), {
      previous: previousBinding,
      requested: binding,
    });
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_SOURCE_CONFLICT' });
  }
  if (!previousBinding)
    await writeFile(statePath, JSON.stringify(binding), {
      flag: 'wx',
      mode: 0o600,
    });
  // Keep the paid image ledger namespace fixed across resumptions as well.
  const imageStorePath = join(output, 'private', 'image-store-binding.json');
  const imageStoreBinding = {
    dataDirectory: resolve(config.get('IMAGE_DATA_DIR')),
  };
  const previousImageStore = await optionalJson(imageStorePath);
  if (
    previousImageStore &&
    digest(previousImageStore) !== digest(imageStoreBinding)
  )
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_SOURCE_CONFLICT' });
  if (!previousImageStore)
    await writeFile(imageStorePath, JSON.stringify(imageStoreBinding), {
      flag: 'wx',
      mode: 0o600,
    });
  await save(join(output, 'private', 'chapter-index.json'), chapter);
  emit('inspect', 'complete', {
    documents: chapter.documents.length,
    blocks: chapter.blocks.length,
    coverage: chapter.covered,
  });

  const privateRoot = join(output, 'private');
  await mkdir(join(privateRoot, 'inputs'), { recursive: true, mode: 0o700 });
  const frozenSource = join(privateRoot, 'inputs', 'source.epub');
  try {
    await copyFile(request.sourcePath, frozenSource, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if ((await hashFile(frozenSource, signal)) !== chapter.sourceSha256)
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_SOURCE_CONFLICT' });

  emit('preflight', 'running');
  const checker = new EpubCheckService(config);
  const preflightPath = join(output, 'private', 'preflight.json');
  let preflight = await optionalJson(preflightPath);
  if (preflight) {
    if (
      preflight.sourceSha256 !== chapter.sourceSha256 ||
      (await hashFile(preflight.outputPath, signal)) !== preflight.outputSha256
    )
      throw Object.assign(new Error(), {
        code: 'ILLUSTRATION_PREFLIGHT_INVALID',
      });
  } else {
    const result = await processEpub({
      sourcePath: frozenSource,
      outputDirectory: await mkdtemp(join(privateRoot, 'preflight-')),
      signal,
    });
    const before = await checker.check(
      frozenSource,
      join(output, 'private', 'source-check.json'),
      signal,
    );
    const baseline = await checker.check(
      result.outputPath,
      join(output, 'private', 'baseline-check.json'),
      signal,
    );
    assertNoNewFormatErrors(before, baseline);
    if (
      baseline.fatal ||
      baseline.errors ||
      result.report.sourceSha256 !== chapter.sourceSha256 ||
      !result.report.summary.bodyBytesPreserved
    )
      throw Object.assign(new Error(), {
        code: 'ILLUSTRATION_PREFLIGHT_INVALID',
      });
    // A private synthetic pixel tests the real insertion compatibility gate
    // before payment. It is never a final illustration or provider input.
    const safeEnd = chapter.anchors.find(
      (item) =>
        item.kind === (request.sectionId ? 'after-paragraph' : 'chapter-end'),
    );
    if (!safeEnd)
      throw Object.assign(new Error(), { code: 'ILLUSTRATION_INVALID_ANCHOR' });
    const probeBytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const probePath = join(privateRoot, 'preflight-pixel.png');
    await writeFile(probePath, probeBytes, { mode: 0o600 });
    await insertEpubIllustration({
      sourcePath: frozenSource,
      sourceSha256: chapter.sourceSha256,
      anchor: safeEnd,
      image: {
        path: probePath,
        sha256: createHash('sha256').update(probeBytes).digest('hex'),
      },
      alt: '技术检查占位像素',
      outputDirectory: await mkdtemp(join(privateRoot, 'insertion-preflight-')),
      signal,
    });
    preflight = {
      sourceSha256: chapter.sourceSha256,
      outputPath: result.outputPath,
      outputSha256: result.report.outputSha256,
      before,
      baseline,
    };
    await save(preflightPath, preflight);
  }
  emit('preflight', 'complete', {
    errors: preflight.baseline.errors,
    warnings: preflight.baseline.warnings,
  });

  const textStateDirectory = resolve(
    request.textStateDirectory ?? join(privateRoot, 'text-state'),
  );
  const textStorePath = join(privateRoot, 'text-store-binding.json');
  const textStoreBinding = { dataDirectory: textStateDirectory };
  const previousTextStore = await optionalJson(textStorePath);
  if (
    previousTextStore &&
    digest(previousTextStore) !== digest(textStoreBinding)
  )
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_SOURCE_CONFLICT' });
  if (!previousTextStore)
    await writeFile(textStorePath, JSON.stringify(textStoreBinding), {
      flag: 'wx',
      mode: 0o600,
    });
  persistence = new LocalProcessingPersistence(textStateDirectory);
  await persistence.initialize();
  const repository = new ProcessingRepository(persistence);
  const bookPath = join(privateRoot, 'book.json');
  let book = await optionalJson(bookPath);
  if (!book) {
    book = await repository.createBook({
      ownerId,
      sourceKey: 'inputs/source.epub',
      sourceHash: chapter.sourceSha256,
      byteSize: (await stat(frozenSource)).size,
      originalName: 'source.epub',
    });
    await save(bookPath, book);
  } else {
    book = await repository.getBook(ownerId, book.id);
    if (book.sourceHash !== chapter.sourceSha256) throw new Error();
  }
  if ((await hashFile(frozenSource, signal)) !== chapter.sourceSha256)
    throw Object.assign(new Error(), { code: 'ILLUSTRATION_SOURCE_CONFLICT' });
  emit('plan', 'running');
  const planner = new ChapterIllustrationPlanner(
    config,
    repository,
    new AiService(config),
    privateRoot,
  );
  if (bookArtEvidence) {
    await save(
      join(privateRoot, 'book-art-evidence.json'),
      bookArtEvidence.snapshot,
    );
    const artPlan = await new BookArtPlanner(planner).plan(
      bookArtEvidence.snapshot,
      chapter,
      { operationId: request.operationId, ownerId, bookId: book.id, signal },
    );
    await save(join(output, 'book-art-plan.json'), artPlan);
    await save(join(output, 'stage-receipt.json'), {
      stage: 'book-art',
      sourceSha256: chapter.sourceSha256,
      chapterId: chapter.chapterId,
      bookArtPlanHash: bookArtPlanHash(artPlan),
    });
    emit('book-art', 'complete', {
      sampledSections: artPlan.coverage.sampledSections,
      sampledParagraphs: artPlan.coverage.sampledParagraphs,
    });
  } else {
    const plan = await planner.plan(chapter, {
      operationId: request.operationId,
      ownerId,
      bookId: book.id,
      recoverReceivedResponses: request.recoverReceivedResponses === true,
      ...(request.sceneDirection
        ? { sceneDirection: request.sceneDirection }
        : {}),
      ...styleInput,
      signal,
    });
    const anchor = chapter.anchors.find(
      (item) =>
        item.id === plan.anchorId &&
        item.kind === (request.sectionId ? 'after-paragraph' : 'chapter-end'),
    );
    if (
      plan.coverage !== 'COMPLETE' ||
      plan.sourceSha256 !== chapter.sourceSha256 ||
      plan.planningPolicy !== request.planningPolicy ||
      !anchor
    )
      throw Object.assign(new Error(), { code: 'ILLUSTRATION_PLAN_INVALID' });
    const imagePrompt = request.imagePromptReview?.prompt ?? plan.imagePrompt;
    if (artDirection) {
      resolveArtDirection(plan.artDirection, styleHash);
      if (plan.artDirectionHash !== styleHash)
        throw Object.assign(new Error(), { code: 'ART_DIRECTION_CONFLICT' });
      // This gate applies equally to the original plan and operator-reviewed
      // prompts. A review cannot switch medium, erase the envelope, or exceed it.
      assertArtDirectedPrompt(
        imagePrompt,
        artDirection,
        request.planningPolicy
          ? { planningPolicy: request.planningPolicy, depicts: plan.depicts }
          : undefined,
      );
    } else if (
      plan.artDirection !== undefined ||
      plan.artDirectionHash !== undefined
    ) {
      throw Object.assign(new Error(), { code: 'ART_DIRECTION_CONFLICT' });
    }
    const imageAlt = request.imagePromptReview?.alt ?? plan.alt;
    if (
      !imageAlt.trim() ||
      !imageAlt.isWellFormed() ||
      Array.from(imageAlt).length > 500 ||
      Array.from(imageAlt).some((char) => {
        const code = char.codePointAt(0);
        return !(
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 0x20 && code <= 0xd7ff) ||
          (code >= 0xe000 && code <= 0xfffd) ||
          (code >= 0x10000 && code <= 0x10ffff)
        );
      })
    )
      throw Object.assign(new Error(), { code: 'INVALID_ILLUSTRATION_ALT' });
    const sourcePlanHash = digest({
      sourceSha256: plan.sourceSha256,
      chapterId: plan.chapterId,
      coverage: plan.coverage,
      summary: plan.summary,
      emotionalReading: plan.emotionalReading,
      facts: plan.facts,
      anchorId: plan.anchorId,
      concept: plan.concept,
      imagePrompt: plan.imagePrompt,
      alt: plan.alt,
      ...(plan.layout
        ? {
            layout: plan.layout,
            settingEvidenceBlockIds: plan.settingEvidenceBlockIds,
            ...(plan.sceneEvidenceBlockIds
              ? { sceneEvidenceBlockIds: plan.sceneEvidenceBlockIds }
              : {}),
            ...(plan.layoutSource ? { layoutSource: plan.layoutSource } : {}),
          }
        : {}),
      ...(plan.artDirection
        ? {
            artDirection: plan.artDirection,
            artDirectionHash: plan.artDirectionHash,
          }
        : {}),
      ...(plan.visualPlan ? { visualPlan: plan.visualPlan } : {}),
      ...(plan.sceneDescription
        ? { sceneDescription: plan.sceneDescription }
        : {}),
      ...(plan.planningPolicy ? { planningPolicy: plan.planningPolicy } : {}),
    });
    if (
      request.imagePromptReview &&
      request.imagePromptReview.sourcePlanHash !== sourcePlanHash
    )
      throw Object.assign(new Error(), {
        code: 'ILLUSTRATION_REVIEW_CONFLICT',
      });
    const planHash = request.imagePromptReview
      ? digest({ sourcePlanHash, review: request.imagePromptReview })
      : sourcePlanHash;
    await save(join(output, 'plan.json'), plan);
    if (request.imagePromptReview)
      await save(join(output, 'image-prompt-review.json'), {
        sourceSha256: chapter.sourceSha256,
        chapterId: chapter.chapterId,
        sourcePlanHash,
        effectivePlanHash: planHash,
        ...request.imagePromptReview,
        operatorReviewed: true,
      });
    emit('plan', 'complete', {
      textCalls: plan.modelCalls.length,
      coverage: plan.coverage,
    });
    if (until === 'plan') {
      await save(join(output, 'stage-receipt.json'), {
        stage: 'plan',
        sourceSha256: chapter.sourceSha256,
        chapterId: chapter.chapterId,
        chapterTitle: chapter.title,
        sourcePlanHash,
        planPath: join(output, 'plan.json'),
      });
    } else {
      emit('image', 'running');
      const image = await application.get(ImageGenerationService).generateOne(
        {
          ownerId,
          operationId: request.operationId,
          callKey: artDirection
            ? `${request.sectionId ? 'section' : 'chapter'}-image-v3-art-${styleHash}`
            : request.sectionId
              ? 'section-image-v2'
              : 'chapter-image-v1',
          prompt: imagePrompt,
        },
        signal,
      );
      await save(join(output, 'image-receipt.json'), image);
      emit('image', 'complete', {
        callId: image.callId,
        reused: image.reused,
        width: image.asset.width,
        height: image.asset.height,
      });
      if (until === 'image') {
        await save(join(output, 'stage-receipt.json'), {
          stage: 'image',
          callId: image.callId,
          sourceSha256: chapter.sourceSha256,
          chapterId: chapter.chapterId,
          sourcePlanHash,
          anchorId: anchor.id,
        });
      } else {
        emit('insert', 'running');
        const finalPath = join(output, 'pipeline-result.json');
        let final = await optionalJson(finalPath);
        if (final) {
          if (
            final.sourceSha256 !== chapter.sourceSha256 ||
            final.planHash !== planHash ||
            (await hashFile(final.outputPath, signal)) !== final.outputSha256
          )
            throw Object.assign(new Error(), {
              code: 'ILLUSTRATION_EXPORT_CONFLICT',
            });
        } else {
          const insertionPath = join(
            output,
            'private',
            'insertion-checkpoint.json',
          );
          let inserted = await optionalJson(insertionPath);
          if (inserted) {
            if (
              inserted.sourceSha256 !== chapter.sourceSha256 ||
              inserted.planHash !== planHash ||
              inserted.imageSha256 !== image.asset.sha256 ||
              (await hashFile(inserted.outputPath, signal)) !==
                inserted.outputSha256
            )
              throw Object.assign(new Error(), {
                code: 'ILLUSTRATION_EXPORT_CONFLICT',
              });
          } else {
            const result = await insertEpubIllustration({
              sourcePath: frozenSource,
              sourceSha256: chapter.sourceSha256,
              anchor,
              image: { path: image.asset.path, sha256: image.asset.sha256 },
              alt: imageAlt,
              ...(plan.layout
                ? { layout: { size: plan.layout, alignment: 'center' } }
                : {}),
              outputDirectory: await mkdtemp(join(privateRoot, 'export-')),
              signal,
            });
            inserted = {
              sourceSha256: chapter.sourceSha256,
              planHash,
              imageSha256: image.asset.sha256,
              outputPath: result.outputPath,
              reportPath: result.reportPath,
              outputSha256: await hashFile(result.outputPath, signal),
            };
            await save(insertionPath, inserted);
          }
          emit('insert', 'complete', { reportPath: inserted.reportPath });
          emit('validate', 'running');
          const after = await checker.check(
            inserted.outputPath,
            join(output, 'output-check.json'),
            signal,
          );
          assertNoNewFormatErrors(preflight.baseline, after);
          if (
            after.errors ||
            after.fatal ||
            (await hashFile(request.sourcePath, signal)) !==
              chapter.sourceSha256
          )
            throw Object.assign(new Error(), {
              code: 'ILLUSTRATION_OUTPUT_INVALID',
            });
          const publishedPath = join(output, 'illustrated.epub');
          try {
            await link(inserted.outputPath, publishedPath);
          } catch (error) {
            if (
              error.code !== 'EEXIST' ||
              (await hashFile(publishedPath, signal)) !== inserted.outputSha256
            )
              throw Object.assign(new Error(), {
                code: 'ILLUSTRATION_EXPORT_CONFLICT',
              });
          }
          const publishedReportPath = join(output, 'illustration-report.json');
          await save(publishedReportPath, await json(inserted.reportPath));
          final = {
            schemaVersion: 1,
            sourceSha256: chapter.sourceSha256,
            chapterId: chapter.chapterId,
            chapterTitle: chapter.title,
            coverage: chapter.covered,
            documents: chapter.documents.length,
            blocks: chapter.blocks.length,
            anchorId: anchor.id,
            planHash,
            sourcePlanHash,
            imagePromptReviewed: Boolean(request.imagePromptReview),
            imageCallId: image.callId,
            imageSha256: image.asset.sha256,
            outputPath: publishedPath,
            outputSha256: await hashFile(inserted.outputPath, signal),
            byteSize: (await stat(inserted.outputPath)).size,
            check: after,
            illustrationReportPath: publishedReportPath,
            textCalls: plan.modelCalls,
            imageEstimatedMicros: image.estimatedCostMicros,
            ...(plan.artDirection
              ? {
                  artDirection: plan.artDirection,
                  artDirectionHash: plan.artDirectionHash,
                  visualReview: 'unreviewed',
                }
              : {}),
            ...(plan.visualPlan ? { visualPlan: plan.visualPlan } : {}),
            readerDeviceValidated: false,
            uploadUiIntegrated: false,
          };
          await save(finalPath, final);
        }
        emit('export', 'complete', {
          outputSha256: final.outputSha256,
          byteSize: final.byteSize,
          errors: final.check.errors,
          warnings: final.check.warnings,
        });
      }
    }
  }
} catch (error) {
  const code =
    typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code
      : 'ILLUSTRATION_CLI_FAILED';
  process.stderr.write(JSON.stringify({ error: { code } }) + '\n');
  process.exitCode = 1;
} finally {
  await persistence?.close();
  await application?.close();
  process.off('message', cancelFromParent);
  if (process.connected) process.disconnect();
}

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { LocalFeedbackPersistence } from '../dist/business/feedback-persistence.js';

// Explicit operator command only. Nothing is sent to an external service.
try {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      limit: { type: 'string', default: '50' },
    },
    allowPositionals: false,
  });
  if (
    !values['data-dir'] ||
    !/^\d+$/u.test(values.limit) ||
    Number(values.limit) < 1 ||
    Number(values.limit) > 500
  )
    throw new Error('INVALID_ARGUMENTS');
  const store = new LocalFeedbackPersistence(values['data-dir']);
  const records = await store.readForOperator();
  console.log(
    JSON.stringify(
      records
        .slice(-Number(values.limit))
        .map(({ receiptId, createdAt, expiresAt, payload }) => ({
          receiptId,
          createdAt,
          expiresAt,
          payload,
        })),
      null,
      2,
    ),
  );
} catch {
  process.stderr.write(
    'Feedback could not be read. Use --data-dir ABSOLUTE_PRIVATE_DATA_DIRECTORY [--limit 1..500] with the service account.\n',
  );
  process.exitCode = 1;
}

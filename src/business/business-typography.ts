import { z } from 'zod';
const count = z.number().int().nonnegative();
export const typographySummarySchema = z
  .object({
    profile: z.literal('editorial-1'),
    totalParagraphs: count,
    styledParagraphs: count,
    preservedParagraphs: count,
    styledHeadings: count,
    roleCounts: z.object({
      body: count,
      opening: count,
      quote: count,
      poem: count,
      caption: count,
      note: count,
      separator: count,
    }),
  })
  .refine(
    (value) =>
      value.styledParagraphs + value.preservedParagraphs ===
        value.totalParagraphs &&
      Object.entries(value.roleCounts)
        .filter(([role]) => role !== 'separator')
        .reduce((sum, [, number]) => sum + number, 0) ===
        value.styledParagraphs,
  );

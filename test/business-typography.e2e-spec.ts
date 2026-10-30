import { typographySummarySchema } from '../src/business/business-typography.js';

const legacy = {
  profile: 'editorial-1',
  totalParagraphs: 2,
  styledParagraphs: 2,
  preservedParagraphs: 0,
  styledHeadings: 1,
  roleCounts: {
    body: 1,
    opening: 1,
    quote: 0,
    poem: 0,
    caption: 0,
    note: 0,
    separator: 1,
  },
};

describe('typography summary paragraph accounting', () => {
  it('accepts historical hr-only separators without adding them to paragraph totals', () => {
    expect(typographySummarySchema.safeParse(legacy).success).toBe(true);
    expect(
      typographySummarySchema.parse(legacy).styledSeparatorParagraphs,
    ).toBeUndefined();
  });
  it('accepts exact paragraph-separator counts separately from hr separators', () => {
    expect(
      typographySummarySchema.safeParse({
        ...legacy,
        totalParagraphs: 3,
        styledParagraphs: 3,
        styledSeparatorParagraphs: 1,
        roleCounts: { ...legacy.roleCounts, separator: 2 },
      }).success,
    ).toBe(true);
  });
  it.each([
    [
      'missing counted paragraph',
      { ...legacy, totalParagraphs: 3, styledParagraphs: 3 },
    ],
    ['extra paragraph', { ...legacy, styledSeparatorParagraphs: 1 }],
    [
      'separator paragraph exceeds all separators',
      {
        ...legacy,
        totalParagraphs: 4,
        styledParagraphs: 4,
        styledSeparatorParagraphs: 2,
      },
    ],
    [
      'negative separator paragraph',
      { ...legacy, styledSeparatorParagraphs: -1 },
    ],
    [
      'fractional separator paragraph',
      { ...legacy, styledSeparatorParagraphs: 0.5 },
    ],
    ['wrong total', { ...legacy, totalParagraphs: 3 }],
  ])('rejects %s without weakening exact sums', (_label, value) => {
    expect(typographySummarySchema.safeParse(value).success).toBe(false);
  });
});

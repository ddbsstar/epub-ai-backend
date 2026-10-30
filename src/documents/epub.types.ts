import type {
  EditorialAssignment,
  EditorialSummary,
  EditorialDocument,
} from '../layout/editorial-typography.js';

export interface EpubLimits {
  maxSourceBytes: number;
  maxEntries: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxXmlBytes: number;
  maxCompressionRatio: number;
}

export const DEFAULT_EPUB_LIMITS: Readonly<EpubLimits> = Object.freeze({
  maxSourceBytes: 100 * 1024 * 1024,
  maxEntries: 5_000,
  maxExpandedBytes: 256 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  maxXmlBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 200,
});

export class EpubProcessingError extends Error {
  constructor(
    public readonly code: string,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
    this.name = 'EpubProcessingError';
  }
}

export interface EpubWarning {
  code: string;
  message: string;
  document?: string;
}

export interface EpubDocumentReport {
  path: string;
  status: 'styled' | 'preserved';
  reasons: string[];
  paragraphs: number;
  headings: number;
  bodySha256: string;
  editorial?: {
    profile: 'editorial-1';
    cssPath: string | null;
    assignments: EditorialAssignment[];
    language?: EditorialDocument['language'];
    styledSeparatorParagraphs?: number;
  };
}

export interface EpubSourceRepair {
  path: string;
  sourceSha256: string;
  outputSha256: string;
  removedFontFaces: {
    family: string;
    reference: string;
    sourceStart: number;
    sourceEnd: number;
    removedSha256: string;
  }[];
}
export interface EpubSourceRepairs {
  policyVersion: 'unused-font-placeholder-1';
  stylesheets: EpubSourceRepair[];
}

export interface EpubReport {
  schemaVersion: 1;
  pipelineVersion: 'reader-first-1';
  sourceSha256: string;
  outputSha256: string;
  summary: {
    title: string | null;
    chapters: number;
    styledChapters: number;
    preservedChapters: number;
    bodyBytesPreserved: boolean;
    entries: number;
    expandedBytes: number;
    spineDocuments: number;
    styledDocuments: number;
    preservedDocuments: number;
    images: number;
  };
  documents: EpubDocumentReport[];
  structure: {
    schemaVersion: 1;
    analyzerVersion: 'structure-samples-1';
    snapshotFingerprint: string;
    sampledBlocks: number;
    truncated: boolean;
    planned: boolean;
    appliedBlocks: number;
    preservedBlocks: number;
    roleCounts: Record<EpubStructureRole, number>;
  };
  warnings: EpubWarning[];
  sourceRepairs?: EpubSourceRepairs;
  typography?: EditorialSummary;
  integrity: {
    sourceUnchanged: true;
    bodyBytesPreserved: true;
    originalResourcesPreserved: boolean;
    spineOrderPreserved: true;
    navigationPreserved: true;
    internalReferencesChecked: true;
  };
  validation: {
    archive: 'passed';
    xml: 'passed';
    references: 'passed';
    epubcheck: 'not-run';
    device: 'not-tested';
  };
}

export interface EpubProcessOptions {
  sourcePath: string;
  outputDirectory: string;
  limits?: Partial<EpubLimits>;
  signal?: AbortSignal;
  structurePlan?: EpubStructurePlan;
  typographyProfile?: 'editorial-1';
}

export const EPUB_STRUCTURE_ROLES = [
  'body',
  'quote',
  'poem',
  'caption',
  'section-title',
] as const;
export type EpubStructureRole = (typeof EPUB_STRUCTURE_ROLES)[number];

export interface EpubStructureBlock {
  id: string;
  documentPath: string;
  position: { childIndex: number; start: number; end: number };
  contentSha256: string;
  excerpt: string;
  originalClass: string;
  allowedRoles: EpubStructureRole[];
}

export interface EpubStructureSnapshot {
  schemaVersion: 1;
  analyzerVersion: 'structure-samples-1';
  sourceSha256: string;
  fingerprint: string;
  blocks: EpubStructureBlock[];
  truncated: boolean;
}

export interface EpubStructurePlan {
  schemaVersion: 1;
  sourceSha256: string;
  snapshotFingerprint: string;
  roles: { id: string; role: EpubStructureRole }[];
}

export interface EpubInspectOptions {
  sourcePath: string;
  limits?: Partial<EpubLimits>;
  signal?: AbortSignal;
}

export interface EpubProcessResult {
  outputPath: string;
  reportPath: string;
  cover?: { path: string; mediaType: 'image/jpeg' | 'image/png' };
  report: EpubReport;
}

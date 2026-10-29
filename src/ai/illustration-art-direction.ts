import { createHash } from 'node:crypto';
import { z } from 'zod';

/** A registered prompt contract, not evidence that an image passed art review. */
const legacyArtDirectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.literal('literary-editorial'),
    version: z.literal(2),
    status: z.literal('provisional'),
    originality: z.literal('original-no-specific-artist-imitation'),
    medium: z.literal('flat hand-drawn literary editorial illustration'),
    paper: z.literal('warm near-white negative space'),
    palette: z.literal('charcoal, muted slate, muted ochre'),
    contours: z.literal('restrained charcoal contours'),
    shading: z.literal('flat color shapes and sparse hatching'),
    density: z.literal(
      'selective detail; no dense tonal or material rendering',
    ),
    bookConsistency: z.literal(
      'fixed medium, palette, line language and density',
    ),
    emotionPolicy: z.literal(
      'vary composition, distance, spacing and tonal distribution only',
    ),
    sourcePolicy: z.literal('no invented objects or unsupported symbols'),
  })
  .strict();

export type LiteraryArtDirection = Readonly<
  z.infer<typeof legacyArtDirectionSchema>
>;

const visualPhrase = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => codepoints(value) <= max)
    .refine((value) => value.trim() === value)
    .refine((value) => /^[\p{L}\p{M}\p{N} ,，、·\-–—/()（）]+$/u.test(value));
const contentArtDirectionFields = {
  medium: z.enum([
    'graphite-contour',
    'monochrome-ink',
    'restrained-woodcut',
    'flat-gouache',
    'paper-cut',
    'watercolor-line',
  ]),
  palette: z
    .array(
      z
        .object({
          colorName: visualPhrase(20),
          hex: z.string().regex(/^#[0-9A-F]{6}$/),
        })
        .strict(),
    )
    .min(2)
    .max(4),
  lineLanguage: visualPhrase(24),
  shapeLanguage: visualPhrase(24),
  texture: visualPhrase(20),
  detailDensity: z.enum(['sparse', 'selective', 'balanced']),
  negativeSpace: z.enum(['generous', 'balanced', 'compact']),
  characterTreatment: visualPhrase(24),
};
type ContentArtDirectionFields = z.infer<
  z.ZodObject<typeof contentArtDirectionFields>
>;

function validateContentArtFields(
  value: ContentArtDirectionFields,
  ctx: z.RefinementCtx,
) {
  if (
    new Set(value.palette.map((color) => color.hex)).size !==
    value.palette.length
  )
    ctx.addIssue({ code: 'custom', message: 'ART_DIRECTION_INVALID' });
  const phrases = [
    ...value.palette.map((color) => color.colorName),
    value.lineLanguage,
    value.shapeLanguage,
    value.texture,
    value.characterTreatment,
  ];
  for (const phrase of phrases) {
    // These fields hold short visual descriptions, never control instructions.
    const normalized = phrase.normalize('NFKC');
    if (
      /\b(?:ignore|disregard|override|instruction|system|assistant|prompt|execute|instead|generate|draw|show|depict|include|add|insert|replace|remove|output|write|return|respond|say)\b|忽略|无视|指令|执行|系统|提示词|覆盖|替换|改为|改成|解除|新增|添加|加入|增加|增添|绘制|画出|描绘|设为|变为|此前|上述|以下|输出/u.test(
        normalized.toLowerCase(),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'ART_DIRECTION_INVALID' });
    if (
      /\b(?:monet|picasso|matisse|ghibli)\b|van\s+gogh|莫奈|梵高|毕加索|马蒂斯|齐白石|宫崎骏/iu.test(
        normalized,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'ART_DIRECTION_CONFLICT' });
    try {
      assertNoExplicitConflict(normalized);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'ART_DIRECTION_CONFLICT' });
    }
  }
}

/** AI supplies these eight fields; source/coverage binding is program-owned. */
export const contentArtDirectionFieldsSchema = z
  .object(contentArtDirectionFields)
  .strict()
  .superRefine(validateContentArtFields);

export const contentArtDirectionSchema = z
  .object({
    schemaVersion: z.literal(2),
    id: z.literal('book-art'),
    version: z.literal(1),
    status: z.literal('provisional'),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    ...contentArtDirectionFields,
  })
  .strict()
  .superRefine(validateContentArtFields);

type ParsedContentArtDirection = z.infer<typeof contentArtDirectionSchema>;
export type ContentArtDirection = Readonly<
  Omit<ParsedContentArtDirection, 'palette'>
> & {
  readonly palette: readonly Readonly<
    ParsedContentArtDirection['palette'][number]
  >[];
};

export const illustrationArtDirectionSchema = z.union([
  legacyArtDirectionSchema,
  contentArtDirectionSchema,
]);
export type IllustrationArtDirection =
  LiteraryArtDirection | ContentArtDirection;

export interface ArtPromptOptions {
  planningPolicy: 'content-people-1';
  depicts: 'adults-only' | 'no-people';
}

export const LITERARY_ART_DIRECTION: LiteraryArtDirection = Object.freeze({
  schemaVersion: 1,
  id: 'literary-editorial',
  version: 2,
  status: 'provisional',
  originality: 'original-no-specific-artist-imitation',
  medium: 'flat hand-drawn literary editorial illustration',
  paper: 'warm near-white negative space',
  palette: 'charcoal, muted slate, muted ochre',
  contours: 'restrained charcoal contours',
  shading: 'flat color shapes and sparse hatching',
  density: 'selective detail; no dense tonal or material rendering',
  bookConsistency: 'fixed medium, palette, line language and density',
  emotionPolicy:
    'vary composition, distance, spacing and tonal distribution only',
  sourcePolicy: 'no invented objects or unsupported symbols',
});

export class IllustrationArtDirectionError extends Error {
  constructor(
    readonly code:
      | 'ART_DIRECTION_INVALID'
      | 'ART_DIRECTION_CONFLICT'
      | 'ILLUSTRATION_PEOPLE_CONFLICT'
      | 'ILLUSTRATION_PROMPT_LIMIT',
  ) {
    // Never include book text, prompts or caller-provided values in errors.
    super(code);
    this.name = 'IllustrationArtDirectionError';
  }
}

const MAX_PROMPT_CODEPOINTS = 800;
const PREFIX =
  '原创文学编辑插画；flat hand-drawn literary editorial illustration。\n' +
  '统一艺术方向 literary-editorial@2（暂定，尚未通过实图审美确认）：暖近白留白、炭灰轮廓、石板灰与赭石的低饱和有限色板；平面色块、少量排线；不做密集明暗塑形和写实材质。全书固定媒介、色板、线条语言与细节密度，不模仿具体作者。\n' +
  '【本幅来源场景】\n';
const SUFFIX =
  '\n【必须遵守的艺术约束】\n' +
  '保留上述场景的事实与对象关系；情绪仅调整构图、观看距离、疏密和明暗分布，不新增无原文依据的对象或象征。维持平面手绘语言与留白，不采用摄影、照片写实、相机镜头效果或3D渲染，不改变全书媒介和色板。画面无文字、标题、水印。';

const codepoints = (value: string) => Array.from(value).length;
function fail(code: IllustrationArtDirectionError['code']): never {
  throw new IllustrationArtDirectionError(code);
}

function registered(snapshot: unknown): IllustrationArtDirection {
  if (legacyArtDirectionSchema.safeParse(snapshot).success)
    return LITERARY_ART_DIRECTION;
  const parsed = contentArtDirectionSchema.safeParse(snapshot);
  if (!parsed.success) {
    if (
      parsed.error.issues.some(
        (issue) => issue.message === 'ART_DIRECTION_CONFLICT',
      )
    )
      fail('ART_DIRECTION_CONFLICT');
    fail('ART_DIRECTION_INVALID');
  }
  // Freeze a validated clone, including palette entries, never the caller's data.
  return Object.freeze({
    ...parsed.data,
    palette: Object.freeze(
      parsed.data.palette.map((color) => Object.freeze({ ...color })),
    ),
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? fail('ART_DIRECTION_INVALID');
}

export function getIllustrationArtDirection(): LiteraryArtDirection {
  return LITERARY_ART_DIRECTION;
}

export function artDirectionHash(
  snapshot: unknown = LITERARY_ART_DIRECTION,
): string {
  return createHash('sha256')
    .update(canonical(registered(snapshot)), 'utf8')
    .digest('hex');
}

export function resolveArtDirection(
  snapshot: unknown,
  expectedHash?: string,
  expectedSourceSha256?: string,
): IllustrationArtDirection {
  const value = registered(snapshot);
  if (
    expectedHash !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expectedHash) ||
      expectedHash !== artDirectionHash(value))
  )
    fail('ART_DIRECTION_INVALID');
  if (
    expectedSourceSha256 !== undefined &&
    (!/^[a-f0-9]{64}$/.test(expectedSourceSha256) ||
      (value.id === 'book-art' && value.sourceSha256 !== expectedSourceSha256))
  )
    fail('ART_DIRECTION_INVALID');
  return value;
}

/** Bounded lexical conflict gate; it cannot prove visual or semantic quality. */
function assertNoExplicitConflict(scene: string) {
  const conflicts =
    /photorealis(?:tic|m)|photo[ -]?real(?:istic|ism)?|photograph(?:y|ic)?|摄影|照片(?:级|风格|效果|质感|感|写实)?|camera(?:\s+(?:lens|lighting|shot|effect))?|dslr|bokeh|(?:3d|cgi)[ -]?(?:render(?:ing)?|渲染)|三维(?:渲染|建模)|相机镜头(?:效果)?|in\s+the\s+style\s+of\s+[^,;。；\n]+|(?:painted|drawn)\s+by\s+[^,;。；\n]+|(?:模仿|仿照|临摹|复刻)(?:具体作者|特定作者|某位画家|某位艺术家|某位作者|[\p{Script=Han}·]{2,12}(?:的)?(?:画风|风格|笔触|画作|作品))|(?:莫奈|梵高|毕加索|马蒂斯|齐白石|宫崎骏)(?:的)?(?:风格|画风|笔触)/giu;
  // A contrast begins a new instruction: "不要摄影，但使用3D渲染" must fail.
  const clauses = scene.split(
    /[;。；.!?！？\n]|但是|而是|而要|而用|改为|\bbut\b|\bhowever\b|\binstead\b/iu,
  );
  for (const clause of clauses) {
    let previousEnd = 0;
    let previousNegated: boolean = false;
    for (const match of clause.matchAll(conflicts)) {
      const before = clause.slice(0, match.index);
      const englishNegation =
        /(?:\bno|\bnot|\bwithout|\bavoid|\bexclude|\bexcluding|\bnon)[\s-]*(?:(?:any|a|an|the)\s+)?$/iu.test(
          before,
        );
      const chineseNegation =
        /(?:不要|不用|禁止|避免|排除|没有|无|非|不)(?:采用|使用|呈现|模拟|加入|追求|做成|画成)?\s*$/u.test(
          before,
        );
      const inheritedNegation: boolean =
        previousNegated &&
        /^[\s,，、/]*(?:(?:and|or|和|或|及|与)[\s,，、/]*)?$/iu.test(
          clause.slice(previousEnd, match.index),
        );
      previousNegated = englishNegation || chineseNegation || inheritedNegation;
      previousEnd = match.index + match[0].length;
      if (!previousNegated) fail('ART_DIRECTION_CONFLICT');
    }
  }
}

function assertPromptSize(prompt: string) {
  if (codepoints(prompt) > MAX_PROMPT_CODEPOINTS)
    fail('ILLUSTRATION_PROMPT_LIMIT');
}

/** A bounded lexical gate, not proof of semantic absence or source age. */
export function assertNoPeopleConflict(scene: string): void {
  const people =
    /人物|人形|人群|人影|人像|人体|人偶|人脸|人头|人面|人手|人脚|人们|男人|女人|男子|女子|男孩|女孩|孩子|儿童|少年|少女|婴儿|幼儿|老人|老者|成年(?:人|男性|女性|男子|女子)?|旅人|旅客|行人|士兵|侍从|僧人|喇嘛|骑马者|骑手|骑士|骑兵|站立者|跪伏者|跪地者|行走者|人的(?:身影|轮廓|剪影|姿态)|\b(?:humans?|people|persons?|women|woman|men|man|children|child|adults?|riders?|pedestrians?|soldiers?|monks?|human\s+figures?)\b/giu;
  const clauses = scene.split(
    /[;。；.!?！？\n]|但是|而是|而要|而用|改为|\bbut\b|\bhowever\b|\binstead\b/iu,
  );
  for (const clause of clauses) {
    let previousEnd = 0;
    let previousNegated = false;
    for (const match of clause.matchAll(people)) {
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index + match[0].length);
      const negatedBefore =
        /(?:\bno|\bnot|\bwithout|\bavoid|\bexclude|\bexcluding|\bnon)[\s-]*(?:(?:any|a|an|the)\s+)?$/iu.test(
          before,
        ) ||
        /(?:无|没有|禁止|不要|不许|不得|不准|不|非)(?:出现|描绘|绘制|画出|画|见到|见|显示|包含|包括|呈现|保留|添加|加入|采用|使用)?(?:任何|具体|可见|额外|真实|的|一个|一位)*\s*$/u.test(
          before,
        );
      const negatedAfter =
        /^(?:(?:的)?(?:缺席|缺位|缺失)|(?:均|都|一律)?(?:不出现|不得出现|不描绘|不绘制|不保留|不存在)|[-\s]*free\b)/iu.test(
          after,
        );
      const inheritedNegation: boolean =
        previousNegated &&
        /^[\s,，、/]*(?:(?:and|or|和|或|及|与)[\s,，、/]*)?$/iu.test(
          clause.slice(previousEnd, match.index),
        );
      previousNegated = negatedBefore || negatedAfter || inheritedNegation;
      previousEnd = match.index + match[0].length;
      if (!previousNegated) fail('ILLUSTRATION_PEOPLE_CONFLICT');
    }
  }
}

function promptEnvelope(
  direction: IllustrationArtDirection,
  options?: ArtPromptOptions,
) {
  if (
    options &&
    (options.planningPolicy !== 'content-people-1' ||
      !['adults-only', 'no-people'].includes(options.depicts) ||
      direction.id !== 'book-art')
  )
    fail('ART_DIRECTION_INVALID');
  if (direction.id === 'literary-editorial')
    return { prefix: PREFIX, suffix: SUFFIX };
  const noPeople = options?.depicts === 'no-people';
  const medium = {
    'graphite-contour': '石墨铅笔轮廓线稿',
    'monochrome-ink': '单色墨线与墨面',
    'restrained-woodcut': '克制木刻插画',
    'flat-gouache': '平面水粉插画',
    'paper-cut': '剪纸层叠插画',
    'watercolor-line': '水彩配线描插画',
  }[direction.medium];
  const density = {
    sparse: '稀疏细节',
    selective: '选择性细节',
    balanced: '均衡细节',
  }[direction.detailDensity];
  const space = {
    generous: '充分留白',
    balanced: '均衡留白',
    compact: '紧凑构图中的必要留白',
  }[direction.negativeSpace];
  return {
    prefix:
      `原创文学插画；book-art@1（暂定，尚未通过实图审美确认）。\n` +
      `媒介：${medium}；色板：${direction.palette.map((color) => `${color.colorName}${color.hex}`).join('、')}。\n` +
      `线条：${direction.lineLanguage}；形状：${direction.shapeLanguage}；纹理：${direction.texture}；细节：${density}；留白：${space}` +
      (noPeople
        ? '。\n人物规则：画面中不出现人物、人形或人群，也不出现人形剪影；物件自身的剪影可保留。\n'
        : `；人物处理：${direction.characterTreatment}。\n`) +
      '【本幅来源场景】\n',
    suffix:
      '\n【必须遵守的艺术约束】\n' +
      (noPeople
        ? '全书固定上述媒介、色板、线条、形状、纹理与细节；本幅保持无人，禁止人物、人形和人形剪影。'
        : '全书固定上述媒介、色板、线条、形状、纹理、细节与人物处理。') +
      '情绪仅调整构图、观看距离、疏密和明暗分布，不新增无原文依据的对象或象征；保留来源事实与关系。不模仿具体作者，不采用摄影、照片写实、相机镜头效果或3D渲染；画面无文字、标题、水印。',
  };
}

export function composeArtDirectedPrompt(
  scenePrompt: string,
  snapshot: unknown = LITERARY_ART_DIRECTION,
  options?: ArtPromptOptions,
): string {
  const direction = resolveArtDirection(snapshot);
  if (typeof scenePrompt !== 'string' || !scenePrompt.trim())
    fail('ART_DIRECTION_INVALID');
  assertNoExplicitConflict(scenePrompt);
  if (options?.depicts === 'no-people') assertNoPeopleConflict(scenePrompt);
  const { prefix, suffix } = promptEnvelope(direction, options);
  const result = `${prefix}${scenePrompt}${suffix}`;
  assertPromptSize(result);
  return result;
}

export function assertArtDirectedPrompt(
  prompt: string,
  snapshot: unknown = LITERARY_ART_DIRECTION,
  options?: ArtPromptOptions,
): void {
  const direction = resolveArtDirection(snapshot);
  const { prefix, suffix } = promptEnvelope(direction, options);
  if (
    typeof prompt !== 'string' ||
    !prompt.startsWith(prefix) ||
    !prompt.endsWith(suffix)
  )
    fail('ART_DIRECTION_INVALID');
  assertPromptSize(prompt);
  const scene = prompt.slice(prefix.length, -suffix.length);
  if (!scene.trim()) fail('ART_DIRECTION_INVALID');
  assertNoExplicitConflict(scene);
  if (options?.depicts === 'no-people') assertNoPeopleConflict(scene);
}

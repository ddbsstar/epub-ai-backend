import { ApiException } from '../common/http/api-exception.js';
import { ProcessingError } from '../processing/processing.types.js';

const messages: Record<string, string> = {
  FEEDBACK_DISABLED: 'Feedback is not available on this service.',
  INVALID_FEEDBACK: 'Please check the feedback fields and length limits.',
  FEEDBACK_OWNER_LIMIT:
    'This browser session has reached its feedback limit. Try again after earlier feedback expires.',
  FEEDBACK_CAPACITY_EXCEEDED:
    'The service has reached its feedback capacity. Please try again later.',
  FEEDBACK_UNAVAILABLE:
    'Feedback could not be saved. Please try again later with the same request key.',
  PROCESSING_DISABLED: '书籍处理尚未启用',
  LOCAL_ACCESS_ONLY: '当前书籍处理仅供本机开发使用',
  INVALID_ORIGIN: '请求来源不允许',
  INVALID_UPLOAD: '请选择一个 EPUB 文件',
  UPLOAD_STORAGE_ERROR: '文件保存失败，请稍后重试',
  UPLOAD_TOO_LARGE: '文件超过上传大小限制',
  INVALID_EPUB: '文件不是可读取的 EPUB',
  INVALID_IDEMPOTENCY_KEY: '缺少有效的任务请求编号',
  IDEMPOTENCY_CONFLICT: '相同任务请求编号对应不同参数',
  OWNER_ACTIVE_LIMIT: '已有书籍正在处理，请稍后再试',
  OWNER_BOOK_LIMIT: '试用期最多保留五本书，请在文件到期清理后再试',
  RUN_LIMIT_EXCEEDED: '本地任务容量已满',
  PROCESSING_CAPACITY_EXCEEDED: '已有任务正在处理或本地容量已满，请稍后重试',
  STORAGE_CAPACITY_EXCEEDED: '本机存储空间不足，请先清理任务数据',
  ENCRYPTED_EPUB: '首版暂不支持加密、混淆字体或签名 EPUB',
  FIXED_LAYOUT_EPUB: '首版仅支持可重排文字 EPUB',
  UNSUPPORTED_EPUB_VERSION: '仅支持 EPUB 2 或 EPUB 3',
  UNSUPPORTED_ENCODING: '书籍文档包含首版不支持的编码',
  INVALID_ARCHIVE: 'EPUB 压缩结构无效',
  INVALID_EPUB_STRUCTURE: 'EPUB 内容包结构无效',
  INVALID_XML: '书籍文档格式无效',
  MISSING_RESOURCE: '书籍引用了缺失的资源',
  BROKEN_REFERENCE: '书内链接或目录目标无效',
  SOURCE_SIZE_LIMIT: '书籍超过当前处理大小限制',
  DOCUMENT_SIZE_LIMIT: '单个章节或样式超过处理限制',
  ACTIVE_CONTENT: '首版暂不支持脚本或交互式 EPUB',
  REMOTE_RESOURCE: '首版要求书籍资源完整保存在 EPUB 内',
  BOOK_NOT_FOUND: '书籍不存在或无法访问',
  RUN_NOT_FOUND: '任务不存在或无法访问',
  ARTIFACT_NOT_FOUND: '文件不存在或尚未完成',
  VALIDATION_FAILED: '导出校验未通过，未发布下载文件',
  EPUBCHECK_UNAVAILABLE: '格式检查工具不可用',
  EPUBCHECK_TIMEOUT: '格式检查超时',
  PROCESSING_FAILED: '书籍处理失败，请更换文件或稍后重试',
  ILLUSTRATION_DISABLED: '章节插画尚未启用',
  ILLUSTRATION_BATCH_BUDGET_EXCEEDED:
    '所选章节的保守费用上界超过本次预算，请减少章节或调整允许的预算',
  ILLUSTRATION_CATALOG_CHANGED: '书籍目录已变化，请重新读取章节列表',
  ILLUSTRATION_NO_IMAGES: '所选章节均未生成可用插画，未发布插画版书籍',
  ILLUSTRATION_PRICING_CHANGED: '模型或计价配置已变化，本次转换已停止',
  ILLUSTRATION_OUTPUT_INVALID: '插画文件或来源校验未通过，已停止处理',
  CONVERSION_NO_IMAGES: '所选章节均未生成可用插画，未发布插画版书籍',
  CONVERSION_BUDGET_EXCEEDED: '本次转换已超过当前允许的预算',
  CONVERSION_PRICING_CHANGED: '模型或计价配置已变化，本次转换已停止',
  CONVERSION_SELECTION_INVALID: '章节选择与来源书籍不一致，已停止处理',
  CONVERSION_PROGRESS_INVALID: '转换进度或图片来源未通过校验',
  VISUAL_REVIEW_REJECTED: '图片未通过视觉质检，已保留原因并禁止插入',
  VISUAL_REVIEW_UNCERTAIN: '图片质检结果不确定，未插入书中',
  VISUAL_REVIEW_UNKNOWN_OUTCOME:
    '上次视觉审查结果尚未确认，已停止本节，避免重复收费',
  VISUAL_REVIEW_INVALID: '图片审查记录与原图或构思不一致，未继续插入',
  VISUAL_REVIEW_DISABLED: '视觉质检尚未启用，新转换暂不可用',
  VISUAL_REVIEW_NOT_CONFIGURED: '视觉审查模型尚未配置',
  VISUAL_REVIEW_TIMEOUT: '视觉审查超时，已停止本节并保留调用状态',
  VISUAL_REVIEW_UPSTREAM_ERROR:
    '图片质检调用结果尚未确认，已停止重发，未插入书中',
  VISUAL_REVIEW_UPSTREAM_REJECTED:
    '视觉审查服务返回错误响应，已停止本节，未插入书中',
  VISUAL_REVIEW_TRUNCATED: '视觉审查返回内容不完整，已停止本节，未插入书中',
  VISUAL_REVIEW_BUDGET_EXCEEDED: '已达到视觉审查预算，本节未插入',
  VISUAL_REVIEW_FAILED: '视觉审查未能完成，本节未插入',
  VISUAL_REVIEW_PLAN_INVALID: '插画构思未通过视觉审查输入校验',
  VISUAL_REVIEW_SOURCE_MISMATCH: '视觉审查与原书或构思不一致',
  VISUAL_REVIEW_IMAGE_INVALID: '待审查图片未通过完整性检查',
  VISUAL_REVIEW_INVALID_RESPONSE: '视觉审查返回内容未通过校验，本节未插入',
  CHAPTER_INDEX_LIMIT: '该章节超出当前可生成插画的序号范围',
  NOT_LOGICAL_CHAPTER: '附属目录条目，未识别为可独立配图的正文小节',
  SECTION_SELECTION_REQUIRED: '请选择本章下方的小节',
  INVALID_ILLUSTRATION_SECTION: '小节位置已改变，请重新读取目录',
  ILLUSTRATION_PLACEMENT_MISMATCH: '插图内容与段落位置未通过校验，未继续插入',
  MODEL_DAILY_BUDGET_EXCEEDED: '已达到当天文字分析预算',
  UNSUPPORTED_CHAPTER_STRUCTURE: '该章节结构暂不支持完整分析',
  AMBIGUOUS_CHAPTER_NAVIGATION: '书籍目录与正文标题不一致，暂不能可靠确定章界',
  INVALID_ILLUSTRATION_INPUT: '请检查章节序号、画面描述和图片说明',
  ILLUSTRATION_PLAN_NOT_READY: '插画构思尚未完成，请等待规划结果',
  ILLUSTRATION_REVIEW_CONFLICT: '这份构思已有不同的生成请求，请恢复原任务查看',
  ILLUSTRATION_DECLINED: '本章暂未找到合适的安全画面，请选择其他章节',
  ILLUSTRATION_CHAPTER_LIMIT: '本章超出当前插画分析范围',
  ILLUSTRATION_INVALID_RESPONSE: '模型返回的结构未符合配图要求，未继续生图',
  ILLUSTRATION_INVALID_EVIDENCE: '画面依据未通过校验，未继续生图',
  ILLUSTRATION_PROMPT_LIMIT: '插画规划超过提示长度限制，已停止，尚未提交生图',
  ILLUSTRATION_PEOPLE_CONFLICT: '画面人物要求相互矛盾，已停止，尚未提交生图',
  ILLUSTRATION_PLANNING_FAILED: '插画构思未通过校验，未继续生图',
  ILLUSTRATION_PREFLIGHT_INVALID:
    '原书未通过配图前的格式检查，请修复 EPUB 后重新上传',
  ILLUSTRATION_SOURCE_CONFLICT: '书籍或生成配置已变化，已停止本次处理',
  ILLUSTRATION_REVIEW_INVALID: '画面确认记录未通过校验',
  ILLUSTRATION_CLI_FAILED: '插画处理未完成，请查看当前任务状态',
  ILLUSTRATION_JOB_TIMEOUT: '插画处理超时，已停止本次请求',
  AI_UNKNOWN_OUTCOME: '上次模型请求结果尚未确认，已暂停，避免重复收费',
  AI_UPSTREAM_REJECTED: '模型服务未接受本章分析，尚未提交生图',
  IMAGE_UNKNOWN_OUTCOME: '上次生图结果尚未确认，已暂停，避免重复收费',
  IMAGE_UPSTREAM_REJECTED: '生图服务返回错误响应，已停止重发，未插入书中',
  IMAGE_BUDGET_EXCEEDED: '已达到本次或当天生图预算',
  AI_DAILY_BUDGET_EXCEEDED: '已达到当天文字分析预算',
};

export function safeProcessingMessage(code: string): string {
  return messages[code] ?? messages.PROCESSING_FAILED!;
}

export function businessError(code: string, status = 400): ApiException {
  return new ApiException(
    { code, message: safeProcessingMessage(code) },
    status,
  );
}

export async function exposeProcessingErrors<T>(
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ProcessingError)
      throw businessError(error.code, error.httpStatus);
    throw error;
  }
}

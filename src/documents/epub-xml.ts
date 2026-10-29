import { SaxesParser } from 'saxes';
import { EpubProcessingError } from './epub.types.js';

export interface XmlElement {
  name: string;
  local: string;
  uri: string;
  attrs: Record<string, string>;
  start: number;
  openingEnd: number;
  closingStart: number;
  end: number;
  text: string;
  parent?: XmlElement;
}

export interface XmlDocument {
  source: string;
  elements: XmlElement[];
  ids: Set<string>;
}

/** Strict XML parser. Saxes never resolves external DTDs; internal subsets are refused. */
export function parseXml(bytes: Buffer): XmlDocument {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EpubProcessingError(
      'UNSUPPORTED_ENCODING',
      '仅支持 UTF-8 编码的 EPUB 文档',
    );
  }
  const encoding = source.match(
    /^\s*<\?xml\b[^?]*encoding\s*=\s*["']([^"']+)["']/i,
  )?.[1];
  if (encoding && !/^utf-?8$/i.test(encoding)) {
    throw new EpubProcessingError(
      'UNSUPPORTED_ENCODING',
      '仅支持 UTF-8 编码的 EPUB 文档',
    );
  }
  if (/<!ENTITY\b/i.test(source)) {
    throw new EpubProcessingError(
      'XML_ENTITY_FORBIDDEN',
      '不支持自定义 XML 实体',
    );
  }
  const elements: XmlElement[] = [];
  const ids = new Set<string>();
  const stack: XmlElement[] = [];
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', (value) => {
    if (value.includes('[')) {
      throw new EpubProcessingError(
        'XML_ENTITY_FORBIDDEN',
        '不支持 XML 内部实体定义',
      );
    }
  });
  parser.on('processinginstruction', (instruction) => {
    if (instruction.target.toLowerCase() !== 'xml') {
      throw new EpubProcessingError(
        'ACTIVE_CONTENT',
        '不支持含处理指令的 EPUB',
      );
    }
  });
  parser.on('opentag', (tag) => {
    if (elements.length >= 250_000 || stack.length >= 128) {
      throw new EpubProcessingError(
        'XML_COMPLEXITY_LIMIT',
        '文档结构超出处理限制',
      );
    }
    const openingEnd = parser.position;
    const attrs: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes)) {
      attrs[attribute.name] = attribute.value;
      if (!(attribute.local in attrs)) attrs[attribute.local] = attribute.value;
    }
    const element: XmlElement = {
      name: tag.name,
      local: tag.local,
      uri: tag.uri,
      attrs,
      start: source.lastIndexOf('<', openingEnd - 1),
      openingEnd,
      closingStart: openingEnd,
      end: openingEnd,
      text: '',
      parent: stack.at(-1),
    };
    if (attrs.id) {
      if (ids.has(attrs.id)) {
        throw new EpubProcessingError('DUPLICATE_XML_ID', '文档含重复标识符');
      }
      ids.add(attrs.id);
    }
    elements.push(element);
    stack.push(element);
  });
  parser.on('text', (value) => {
    const element = stack.at(-1);
    if (element) element.text += value;
  });
  parser.on('cdata', (value) => {
    const element = stack.at(-1);
    if (element) element.text += value;
  });
  parser.on('closetag', (tag) => {
    const element = stack.pop();
    if (!element) return;
    element.end = parser.position;
    element.closingStart = tag.isSelfClosing
      ? element.openingEnd
      : source.lastIndexOf('<', element.end - 1);
  });
  try {
    parser.write(source).close();
  } catch (error) {
    if (error instanceof EpubProcessingError) throw error;
    throw new EpubProcessingError(
      'INVALID_XML',
      'EPUB 中存在无效或不支持的 XML 文档',
    );
  }
  return { source, elements, ids };
}

export function onlyElement(document: XmlDocument, local: string): XmlElement {
  const elements = document.elements.filter(
    (element) => element.local === local,
  );
  if (elements.length !== 1) {
    throw new EpubProcessingError(
      'INVALID_EPUB_STRUCTURE',
      'EPUB 结构不完整或存在歧义',
    );
  }
  return elements[0];
}

export function attributeEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;');
}

// ── 应用内预览：docx 转成可以安全显示的 HTML（纯函数，转换器由调用方注入）──────────
//
// docx 由 mammoth 转成语义化的 HTML（标题、段落、列表、表格、粗斜体、图片）。排版细节（页边距、分栏、页眉页脚、
// 文本框）不还原——这是「看内容」的预览，不是 Word。转出来的 HTML 放进沙箱 iframe 里显示：
//   · sandbox="" 不运行脚本、碰不到应用本身；
//   · CSP 禁掉一切网络和脚本，只允许内联样式和 data: 图片；
//   · 链接统一去掉 href（沙箱里点链接会让 iframe 自己跳转到外部页面，这里不需要这个能力）。

import { isOleContainer } from "./preview-zip.js";

export interface DocxConvertResult {
  value: string;
  messages: { type: string; message: string }[];
}

/** 把 docx 字节转成 HTML 片段；浏览器里用 mammoth.browser，测试里用 node 版 */
export type DocxConvert = (bytes: Uint8Array) => Promise<DocxConvertResult>;

export interface DocxPreview {
  /** 完整的 HTML 文档，直接给 iframe 的 srcdoc */
  srcdoc: string;
  /** 转出来没有任何可显示的内容（空文档，或只有转不了的元素） */
  empty: boolean;
}

/** 把 <a ...> 换成不可点的 <span class="lnk">：保留「这里是链接」的外观，去掉跳转能力 */
export function stripLinks(html: string): string {
  return html.replace(/<a\b[^>]*>/gi, '<span class="lnk">').replace(/<\/a>/gi, "</span>");
}

/** 有没有可见内容：有文字，或者有图片、表格 */
function hasVisibleContent(html: string): boolean {
  if (/<(img|table)\b/i.test(html)) return true;
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/gi, "").length > 0;
}

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const STYLE = `
  html { background: #fff; }
  body { margin: 0 auto; max-width: 820px; padding: 28px 36px 48px; color: #1f2328; background: #fff;
    font: 14px/1.75 "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; word-wrap: break-word; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.3em 0 .5em; }
  h1 { font-size: 1.8em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; } h4, h5, h6 { font-size: 1.05em; }
  p { margin: .6em 0; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; margin: .8em 0; max-width: 100%; }
  td, th { border: 1px solid #c9ced4; padding: 4px 9px; vertical-align: top; }
  ul, ol { padding-left: 1.8em; }
  blockquote { margin: .8em 0; padding: 0 1em; border-left: 3px solid #d0d7de; color: #57606a; }
  .lnk { color: #0b5bd3; text-decoration: underline; }
`;

/** 外层的完整 HTML 文档：编码、CSP、样式 */
export function wrapDocxHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>${STYLE}</style></head><body>${body}</body></html>`;
}

/** 转换失败：message 可以直接给用户看 */
export class DocxFormatError extends Error {}

export async function convertDocxToPreview(bytes: Uint8Array, convert: DocxConvert): Promise<DocxPreview> {
  if (isOleContainer(bytes)) throw new DocxFormatError("这个文件设了打开密码，或者是旧版 Word 格式（.doc），无法在应用内预览");
  let value: string;
  try {
    value = (await convert(bytes)).value;
  } catch (e) {
    throw new DocxFormatError(`无法解析这个文档（文件可能已损坏，或不是 docx 格式）：${e instanceof Error ? e.message : String(e)}`);
  }
  const body = stripLinks(value);
  return { srcdoc: wrapDocxHtml(body), empty: !hasVisibleContent(body) };
}

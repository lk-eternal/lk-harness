import { isHttpUrl } from "./preview-url.js"

export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "link"; url: string }

/**
 * 网址到空白、引号、尖括号、右括号、中日文字符和全角标点为止：
 * 「见https://a.com/x，再看」里的网址不会把后面的中文吞进去。
 */
const URL_RE = /https?:\/\/[^\s"'`<>)\]}\u2000-\u206f\u3000-\u9fff\uff00-\uffef]+/gi

/** 紧贴在网址后面的句末标点不算网址的一部分 */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/

/**
 * 把一段自由文字切成「普通文字 / 网址」两种片段，按原顺序排列，拼回去和原文一致。
 * 只认 http(s)；项目的目标、项目信息、相关文档这类自由文本里的网址都靠它变成可点的链接。
 */
export function splitTextLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAILING_PUNCT_RE, "")
    if (!isHttpUrl(url)) continue
    if (m.index > last) parts.push({ kind: "text", text: text.slice(last, m.index) })
    parts.push({ kind: "link", url })
    last = m.index + url.length
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) })
  return parts
}

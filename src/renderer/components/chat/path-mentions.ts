// ── 对话文字里的路径：rehype 插件，把「长得像路径」的文字包成带标记的 span ──────────────
//
// 只做识别和标记（data-lk-path / data-lk-line），能不能点由渲染时向主进程确认的结果决定，见 Markdown.tsx 的 PathLink。
// 不碰链接、代码块、行内代码里的文字：链接已经是链接；代码块里是代码；行内代码由 code 组件整体判断（它能认带空格的路径）。

import { findPathMentions } from "../../../shared/preview-paths"

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SKIP_TAGS = new Set(["a", "pre", "code", "script", "style"])

function splitText(value: string): HastNode[] | undefined {
  const mentions = findPathMentions(value)
  if (mentions.length === 0) return undefined
  const out: HastNode[] = []
  let at = 0
  for (const m of mentions) {
    if (m.start > at) out.push({ type: "text", value: value.slice(at, m.start) })
    out.push({
      type: "element",
      tagName: "span",
      properties: { dataLkPath: m.path, ...(m.line ? { dataLkLine: String(m.line) } : {}) },
      children: [{ type: "text", value: value.slice(m.start, m.end) }],
    })
    at = m.end
  }
  if (at < value.length) out.push({ type: "text", value: value.slice(at) })
  return out
}

function walk(node: HastNode): void {
  if (!node.children) return
  if (node.type === "element" && node.tagName && SKIP_TAGS.has(node.tagName)) return
  const next: HastNode[] = []
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...(splitText(child.value) ?? [child]))
    } else {
      walk(child)
      next.push(child)
    }
  }
  node.children = next
}

/** rehype 插件：就地修改 hast 树 */
export function rehypePathMentions() {
  return (tree: HastNode) => walk(tree)
}

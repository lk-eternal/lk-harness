import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import c from "highlight.js/lib/languages/c"
import cpp from "highlight.js/lib/languages/cpp"
import csharp from "highlight.js/lib/languages/csharp"
import css from "highlight.js/lib/languages/css"
import dart from "highlight.js/lib/languages/dart"
import diff from "highlight.js/lib/languages/diff"
import dockerfile from "highlight.js/lib/languages/dockerfile"
import dos from "highlight.js/lib/languages/dos"
import go from "highlight.js/lib/languages/go"
import graphql from "highlight.js/lib/languages/graphql"
import groovy from "highlight.js/lib/languages/groovy"
import ini from "highlight.js/lib/languages/ini"
import java from "highlight.js/lib/languages/java"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import kotlin from "highlight.js/lib/languages/kotlin"
import less from "highlight.js/lib/languages/less"
import lua from "highlight.js/lib/languages/lua"
import makefile from "highlight.js/lib/languages/makefile"
import nginx from "highlight.js/lib/languages/nginx"
import perl from "highlight.js/lib/languages/perl"
import php from "highlight.js/lib/languages/php"
import powershell from "highlight.js/lib/languages/powershell"
import protobuf from "highlight.js/lib/languages/protobuf"
import python from "highlight.js/lib/languages/python"
import r from "highlight.js/lib/languages/r"
import ruby from "highlight.js/lib/languages/ruby"
import rust from "highlight.js/lib/languages/rust"
import scala from "highlight.js/lib/languages/scala"
import scss from "highlight.js/lib/languages/scss"
import sql from "highlight.js/lib/languages/sql"
import swift from "highlight.js/lib/languages/swift"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import { splitHighlightedLines, splitTextLines } from "../../../shared/preview-text"

const LANGUAGES = {
  bash, c, cpp, csharp, css, dart, diff, dockerfile, dos, go, graphql, groovy, ini, java, javascript, json,
  kotlin, less, lua, makefile, nginx, perl, php, powershell, protobuf, python, r, ruby, rust, scala, scss,
  sql, swift, typescript, xml, yaml,
}
for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition)

/** 超过这个大小不做高亮：高亮在界面线程上同步跑，几百 KB 之后会明显卡 */
export const HIGHLIGHT_MAX_CHARS = 400_000
/** 最多渲染多少行：每行一个 DOM 节点，再多滚动会卡 */
export const MAX_RENDER_LINES = 20_000

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

export interface CodeLines {
  /** 每行一段安全的 HTML（高亮过的，或已转义的纯文本） */
  lines: string[]
  /** 内容超过 MAX_RENDER_LINES，只给了前面一部分 */
  cutOff: boolean
  highlighted: boolean
}

/** 文本 → 按行的 HTML。认识的语言且不太大才高亮，其余按纯文本转义 */
export function toCodeLines(text: string, lang: string | undefined): CodeLines {
  const canHighlight = !!lang && !!hljs.getLanguage(lang) && text.length <= HIGHLIGHT_MAX_CHARS
  let lines = canHighlight
    ? splitHighlightedLines(hljs.highlight(text.replace(/\r\n?/g, "\n"), { language: lang, ignoreIllegals: true }).value)
    : splitTextLines(text).map(escapeHtml)
  // 文件以换行结尾时最后会多出一个空行，不显示
  if (lines.length > 1 && lines[lines.length - 1] === "") lines = lines.slice(0, -1)
  const cutOff = lines.length > MAX_RENDER_LINES
  return { lines: cutOff ? lines.slice(0, MAX_RENDER_LINES) : lines, cutOff, highlighted: canHighlight }
}

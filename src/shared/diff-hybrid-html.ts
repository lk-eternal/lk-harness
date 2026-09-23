import * as fs from "node:fs"
import * as path from "node:path"
import type { HybridDiffData } from "./branch-diff.js"
import { resolveDiffTemplateDir } from "./diff-template-path.js"

function readVendor(name: string): string {
  const p = path.join(resolveDiffTemplateDir(), "vendor", "diff2html", name)
  if (!fs.existsSync(p)) {
    throw new Error(`缺少 ${p}，请在仓库根目录执行 npm run vendor:diff2html`)
  }
  return fs.readFileSync(p, "utf-8")
}

export function scriptSafe(js: string): string {
  return js.replace(/<\/script/gi, "\\x3c/script").replace(/<script/gi, "\\x3cscript")
}

export function assembleHybridDiffHtml(templateHtml: string, data: HybridDiffData): string {
  let html = templateHtml.replace(/\r\n/g, "\n")
  const tplDir = resolveDiffTemplateDir()
  const d2hCss = readVendor("diff2html.min.css")
  const hljsCss = readVendor("github-dark.min.css").replace(/background:#0d1117/g, "background:transparent")
  const hybridCss = fs.readFileSync(path.join(tplDir, "diff-hybrid.css"), "utf-8")

  html = html.replace(
    "</style>",
    `\n/* diff2html + hljs */\n${d2hCss}${hljsCss}\n/* hybrid overrides */\n${hybridCss}\n</style>`,
  )

  const json = JSON.stringify(data).replace(/</g, "\\u003c")
  const uiJs = scriptSafe(readVendor("diff2html-ui-slim.min.js"))
  const runtime = fs.readFileSync(path.join(tplDir, "diff-hybrid-runtime.js"), "utf-8")

  const scriptBlockRe =
    /<script type="application\/json" id="diff-data">[\s\S]*?<\/script>\s*<script>[\s\S]*?<\/script>/
  if (!scriptBlockRe.test(html)) throw new Error("模板缺少 #diff-data 或脚本占位")
  const scriptBlock = `<script type="application/json" id="diff-data">${json}</script>\n<script>\n${uiJs}\n</script>\n<script>\n${runtime}\n</script>`
  html = html.replace(scriptBlockRe, () => scriptBlock)

  if (!html.includes("Diff2HtmlUI")) throw new Error("diff2html-ui 未注入")
  if (html.includes('{"baseLabel":"BASE","headLabel":"HEAD"')) throw new Error("占位 JSON 未替换")
  if ((html.match(/var CONTEXT = 2/g) || []).length > 0) throw new Error("旧行级 diff 脚本仍在模板中")
  return html
}

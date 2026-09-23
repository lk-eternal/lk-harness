/**
 * 将 diff2html / hljs 静态资源复制到 resources/template（打包后 MCP 可读）
 * npm run vendor:diff2html
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const out = path.join(root, "resources", "template", "html", "vendor", "diff2html")
const bundles = path.join(root, "node_modules", "diff2html", "bundles")
const hljs = path.join(root, "node_modules", "diff2html", "node_modules", "highlight.js", "styles", "github-dark.min.css")

const files = [
  [path.join(bundles, "css", "diff2html.min.css"), "diff2html.min.css"],
  [path.join(bundles, "js", "diff2html-ui-slim.min.js"), "diff2html-ui-slim.min.js"],
  [hljs, "github-dark.min.css"],
]

fs.mkdirSync(out, { recursive: true })
for (const [src, name] of files) {
  if (!fs.existsSync(src)) throw new Error(`缺失依赖文件: ${src}（请先 npm install diff2html）`)
  fs.copyFileSync(src, path.join(out, name))
}
console.log("vendored ->", out)

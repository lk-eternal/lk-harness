/**
 * LK 壳 + diff2html 完整样例（cp-scheduling 真实 diff）
 * npx tsx scripts/build-diff-hybrid-sample.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildHybridDiffData } from "../src/shared/branch-diff.ts"
import { assembleHybridDiffHtml } from "../src/shared/diff-hybrid-html.ts"
import { resolveDiffTemplatePath } from "../src/shared/diff-template-path.ts"

const repo = "D:/lk-harness-projects/排课2-0-花果排课效率优化/cp-scheduling"
const baseRef = "origin/release/1.36.1"
const headRef = "HEAD"
const outDir = path.join(repo, ".lk-harness", "artifacts")
const outPath = path.join(outDir, "feature-260917-vs-release-1.36.1-hybrid-full.html")

const data = buildHybridDiffData({
  repoPath: repo,
  baseRef,
  headRef,
  title: "feature/260917 vs release/1.36.1",
  headLabel: "feature/260917-schedule-optimize-v2",
})

let html = assembleHybridDiffHtml(fs.readFileSync(resolveDiffTemplatePath(), "utf-8"), data)
html = html.replace("<h1>分支 Diff 查看器</h1>", "<h1>分支 Diff 查看器 · Hybrid 完整样例</h1>")

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(outPath, html, "utf-8")
const size = fs.statSync(outPath).size
console.log(outPath)
console.log("bytes:", size, `(${(size / 1024).toFixed(1)} KB)`)
console.log("files:", data.file_count)

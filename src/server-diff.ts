import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildHybridDiffData } from "./shared/branch-diff.js"
import { assembleHybridDiffHtml } from "./shared/diff-hybrid-html.js"
import { resolveDiffTemplatePath } from "./shared/diff-template-path.js"

function txt(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

export { resolveDiffTemplatePath } from "./shared/diff-template-path.js"

export function registerDiffTools(mcpServer: McpServer): void {
  mcpServer.tool(
    "render_branch_diff",
    "生成分支对比单文件 HTML（LK 壳 + diff2html 行匹配/高亮）。返回本地绝对路径，再用 send_file 交付用户。",
    {
      base_ref: z.string().describe("Git 基线（commit/branch/tag）"),
      head_ref: z.string().optional().describe("Git 对比端，缺省 HEAD"),
      repo_path: z.string().describe("仓库根或子目录"),
      session_key: z.string().optional().describe("当前会话 sessionKey；传入后 repo_path 必须在其工作目录内（防越界）"),
      paths: z.array(z.string()).optional().describe("只包含这些路径，缺省 base..head 全部变更"),
      title: z.string().optional().describe("页眉展示用（如分支名、MR 标题）"),
      head_label: z.string().optional().describe("页内对比标签文案，缺省由 head_ref 推导"),
    },
    async (args) => {
      try {
        const data = buildHybridDiffData({
          repoPath: args.repo_path,
          baseRef: args.base_ref,
          headRef: args.head_ref,
          paths: args.paths,
          title: args.title,
          headLabel: args.head_label,
          sessionKey: args.session_key,
        })
        const tpl = fs.readFileSync(resolveDiffTemplatePath(), "utf-8")
        const html = assembleHybridDiffHtml(tpl, data)
        const outDir = path.join(os.tmpdir(), "lk-harness-diff")
        fs.mkdirSync(outDir, { recursive: true })
        const out = path.join(outDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.html`)
        fs.writeFileSync(out, html, "utf-8")
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ html_path: out, file_count: data.file_count, commit_count: data.commit_count, stat: data.stat }),
          }],
        }
      } catch (e: any) {
        return txt(`[error] ${e?.message ?? "生成失败"}`)
      }
    },
  )
}

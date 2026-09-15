import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { buildDiffData, injectDiffData } from "./shared/branch-diff.js"

function txt(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

const TEMPLATE_REL = path.join("html", "diff-template.html")

/** 模板定位：daemon 打包后与模板为 resources 下 sibling（daemon/ 与 template/），开发时走 resources/template */
export function resolveDiffTemplatePath(): string {
  const override = process.env.LK_HARNESS_DIFF_TEMPLATE
  if (override && fs.existsSync(override)) return override
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(process.cwd(), "resources", "template", TEMPLATE_REL),
    path.resolve(moduleDir, "..", "template", TEMPLATE_REL), // packaged: resources/daemon/xxx.js → resources/template
    path.resolve(moduleDir, "../../resources/template", TEMPLATE_REL),
    path.resolve(moduleDir, "../../../resources/template", TEMPLATE_REL),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error(`模板缺失: ${TEMPLATE_REL}（cwd=${process.cwd()}）`)
}

export function registerDiffTools(mcpServer: McpServer): void {
  mcpServer.tool(
    "render_branch_diff",
    "生成分支对比单文件 HTML（固定模板，只替换 #diff-data JSON）。返回本地绝对路径，再用 send_file 交付用户。",
    {
      base_ref: z.string().describe("Git 基线（commit/branch/tag）"),
      head_ref: z.string().optional().describe("Git 对比端，缺省 HEAD"),
      repo_path: z.string().describe("仓库根或子目录"),
      paths: z.array(z.string()).optional().describe("只包含这些路径，缺省 base..head 全部变更"),
      title: z.string().optional().describe("页眉展示用（如分支名、MR 标题）"),
      head_label: z.string().optional().describe("页内对比标签文案，缺省由 head_ref 推导"),
    },
    async (args) => {
      try {
        const data = buildDiffData({
          repoPath: args.repo_path,
          baseRef: args.base_ref,
          headRef: args.head_ref,
          paths: args.paths,
          title: args.title,
          headLabel: args.head_label,
        })
        const tpl = fs.readFileSync(resolveDiffTemplatePath(), "utf-8")
        const html = injectDiffData(tpl, data)
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

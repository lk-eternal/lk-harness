/** Harness 内置 MCP 清单（设置页只读展示用）。单一真相是各 register*Tools 函数，本文件由 tests/builtin-mcp-manifest.test.ts 锁死一致。 */

import { BUILTIN_MCP_TOOL_DOCS, type BuiltinToolDoc, type BuiltinToolParamDoc } from "./builtin-mcp-tool-reference.js"

export type { BuiltinToolDoc, BuiltinToolParamDoc }

export interface BuiltinToolEntry {
  name: string
  description: string
  doc?: BuiltinToolDoc
}

export interface BuiltinMcpGroup {
  key: string
  title: string
  scope: string
  tools: BuiltinToolEntry[]
}

export const BUILTIN_MCP_MANIFEST_VERSION = 1

function withDocs(groupKey: string, tools: Omit<BuiltinToolEntry, "doc">[]): BuiltinToolEntry[] {
  return tools.map((t) => {
    const doc = BUILTIN_MCP_TOOL_DOCS[groupKey]?.[t.name]
    return { ...t, ...(doc ? { doc } : {}) }
  })
}

export function getBuiltinMcpManifest(): BuiltinMcpGroup[] {
  return [
    {
      key: "lk-harness",
      title: "LK Harness 工具",
      scope: "所有用户可用",
      tools: withDocs("lk-harness", [
        { name: "send_image", description: "发送本地图片到飞书/微信。" },
        { name: "send_file", description: "发送本地文件到飞书/微信。" },
        { name: "send_question", description: "向用户提问并给出选项按钮。" },
        { name: "render_branch_diff", description: "生成分支对比单文件 HTML，返回本地绝对路径。" },
        { name: "send_text", description: "发送文本消息。仅 task 端点（定时任务/无流式卡片会话）。" },
      ]),
    },
    {
      key: "lk-harness-project",
      title: "LK Harness 项目工具",
      scope: "仅项目会话可用",
      tools: withDocs("lk-harness-project", [
        { name: "project_register_artifact", description: "登记项目最近产物（只写元数据）。" },
        { name: "project_update", description: "更新项目元数据。" },
        { name: "project_get", description: "查询项目（含节点摘要）。" },
        { name: "project_get_node", description: "取某节点全文（含完整提示词）。" },
      ]),
    },
    {
      key: "lk-harness-admin",
      title: "LK Harness 自管理",
      scope: "仅主用户可用",
      tools: withDocs("lk-harness-admin", [
        { name: "manage_agent", description: "管理 Agent 生命周期。" },
        { name: "manage_mcp", description: "管理 Agent 挂载的 MCP。" },
        { name: "manage_rules", description: "管理 Harness 规则。" },
        { name: "manage_skills", description: "管理 Harness Agent Skills。" },
        { name: "manage_tasks", description: "管理定时任务。" },
        { name: "manage_project", description: "管理项目（列出/删除，仅主用户）。" },
        { name: "manage_workspace", description: "管理工作目录。" },
      ]),
    },
  ]
}

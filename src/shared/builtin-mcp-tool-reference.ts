export interface BuiltinToolParamDoc {
  name: string
  required?: boolean
  type?: string
  description?: string
  enumValues?: string[]
}

export interface BuiltinToolDoc {
  summary: string
  params: BuiltinToolParamDoc[]
  example?: string
  notes?: string
}

/** 设置页内置 MCP 详情（与 register*Tools 的 Zod 语义对齐，供 UI 展示） */
export const BUILTIN_MCP_TOOL_DOCS: Record<string, Record<string, BuiltinToolDoc>> = {
  "lk-harness": {
    send_image: {
      summary: "发送本地图片到飞书/微信。",
      params: [
        { name: "image_path", required: true, type: "string", description: "图片绝对路径" },
        { name: "message_id", type: "string", description: "回复某条消息时传入其 message_id" },
      ],
    },
    send_file: {
      summary: "发送本地文件到飞书/微信。",
      params: [
        { name: "file_path", required: true, type: "string", description: "文件绝对路径" },
        { name: "message_id", type: "string", description: "回复模式可选" },
      ],
    },
    send_question: {
      summary: "向用户提问并给出选项按钮（飞书交互卡片）。",
      params: [
        { name: "text", required: true, type: "string", description: "问题题目，简练，不要在题目里写结论" },
        { name: "options", required: true, type: "string[]", description: "1–10 个选项，无需序号" },
        { name: "message_id", type: "string", description: "回复模式可选" },
      ],
    },
    render_branch_diff: {
      summary: "生成分支对比单文件 HTML，返回本地绝对路径；配合 send_file 发送。",
      params: [
        { name: "repo_path", required: true, type: "string", description: "Git 仓库根目录" },
        { name: "base_ref", type: "string", description: "基线分支或 commit，默认 HEAD" },
        { name: "compare_ref", type: "string", description: "对比分支或 commit" },
      ],
    },
    send_text: {
      summary: "发送纯文本。仅 /mcp-task 端点（定时任务等无流式卡会话）。",
      params: [
        { name: "text", required: true, type: "string", description: "消息正文" },
        { name: "message_id", type: "string", description: "回复模式可选" },
      ],
    },
  },
  "lk-harness-project": {
    project_register_artifact: {
      summary: "登记项目最近产物（只写元数据）。",
      params: [{ name: "path", required: true, type: "string", description: "产物路径" }],
    },
    project_update: {
      summary: "更新项目元数据。",
      params: [{ name: "patch", required: true, type: "object", description: "要合并的字段" }],
    },
    project_get: { summary: "查询项目（含节点摘要）。", params: [] },
    project_get_node: {
      summary: "取某节点全文（含完整提示词）。",
      params: [{ name: "node_id", required: true, type: "string", description: "节点 ID" }],
    },
  },
  "lk-harness-admin": {
    manage_agent: {
      summary: "管理 Agent 与应用生命周期。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: ["status", "stop", "restart", "reset", "clean", "launch"],
          description:
            "status：查询 Daemon/Agent/队列/定时任务。stop：停止 Agent。restart：重启应用。reset：重置会话。clean：清空消息队列。launch：新建临时工作目录会话并入队首条消息。",
        },
        { name: "message", required: false, type: "string", description: "launch 时必填：首轮交给 Agent 的任务说明。" },
      ],
      example: "manage_agent({ action: \"launch\", message: \"检查服务器状态\" })",
    },
    manage_mcp: {
      summary: "管理 LK Harness Agent 挂载的 MCP 服务器。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: ["list", "add", "delete"],
          description: "list：列出。add：添加或更新。delete：删除。",
        },
        { name: "name", type: "string", description: "add/delete 必填：MCP 服务器名称（内置 lk-harness* 不可覆盖）" },
        { name: "config", type: "string", description: "add 必填：服务器配置 JSON（command/args/url 等）" },
      ],
    },
    manage_rules: {
      summary: "管理 Harness 规则。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: ["list", "read", "save", "delete"],
          description: "list：列出。read：读取。save：创建或覆盖。delete：删除。",
        },
        { name: "name", type: "string", description: "read/save/delete 必填：规则 id 或文件名（如 my-rule.mdc）" },
        { name: "content", type: "string", description: "save 必填：规则正文（含 frontmatter 可选）" },
      ],
    },
    manage_skills: {
      summary: "管理 Harness Agent Skills。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: ["list", "read", "save", "delete"],
          description: "list：列出。read：读取 SKILL.md。save：创建或覆盖。delete：删除。",
        },
        { name: "name", type: "string", description: "read/save/delete 必填：技能目录名" },
        { name: "content", type: "string", description: "save 必填：SKILL.md 全文" },
      ],
    },
    manage_tasks: {
      summary: "管理 cron 定时任务。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: ["list", "add", "update", "delete", "toggle"],
          description: "list：列出。add：新建。update：改字段。delete：删除。toggle：切换启用。",
        },
        { name: "id", type: "string", description: "update/delete/toggle 必填：任务 ID" },
        { name: "name", type: "string", description: "add 必填：显示名称" },
        { name: "cron", type: "string", description: "add 必填；update 可选：cron 表达式" },
        { name: "content", type: "string", description: "add 必填；update 可选：到点发给 Agent 的任务正文" },
        { name: "enabled", type: "boolean", description: "add 默认 true；update 可选" },
        { name: "independent", type: "boolean", description: "add 默认 true：独立队列、无流式卡" },
      ],
    },
    manage_project: {
      summary: "列出或删除项目（仅主用户）。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: ["list", "delete"],
          description: "list：列出项目。delete：删除项目（删除前须向用户确认）。",
        },
        { name: "project_id", type: "string", description: "delete 必填：项目 ID" },
      ],
    },
    manage_workspace: {
      summary: "查询或请求切换全局工作目录。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: ["get", "set"],
          description: "get：当前目录。set：请求切换（主用户须在私聊卡片批准后才生效）。",
        },
        { name: "dir", type: "string", description: "set 必填：目标目录绝对路径" },
      ],
    },
  },
}

export function getBuiltinToolDoc(groupKey: string, toolName: string): BuiltinToolDoc | undefined {
  return BUILTIN_MCP_TOOL_DOCS[groupKey]?.[toolName]
}

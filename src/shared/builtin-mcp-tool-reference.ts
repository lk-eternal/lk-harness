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
      summary: "向用户提问并给出选项按钮（飞书交互卡片）。默认单选；multi_select=true 为多选。",
      params: [
        { name: "text", required: true, type: "string", description: "问题题目，简练，不要在题目里写结论" },
        { name: "options", required: true, type: "string[]", description: "1–10 个选项，无需序号；多选时选项文本里不要含「、」" },
        { name: "multi_select", type: "boolean", description: "true = 多选：用户勾选多个选项后点「提交」，收到的答案是被选中的选项按题目顺序用「、」连起来；默认 false（点一个就作答）" },
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
    send_result: {
      summary: "提交独立定时任务本次运行的结果。仅 /mcp-task 端点。",
      params: [
        { name: "text", type: "string", description: "结果正文（Markdown）；quiet=true 时可省略" },
        { name: "quiet", type: "boolean", description: "true = 没什么要汇报的，不发消息" },
      ],
      notes: "结果按任务的通知方式送达：不通知 / Agent 会话 / IM。",
    },
  },
  "lk-harness-schedule": {
    schedule_create: {
      summary: "给自己排一个定时任务，到点自动执行。绑定调用它的会话。",
      params: [
        { name: "name", required: true, type: "string", description: "排程名称" },
        { name: "prompt", required: true, type: "string", description: "到点要执行的内容（自包含；fresh 模式下写明什么情况下才汇报）" },
        { name: "every_minutes", type: "number", description: "每隔多少分钟触发一次，与 cron 二选一" },
        { name: "cron", type: "string", description: "cron 表达式（5 段，本地时区），与 every_minutes 二选一" },
        { name: "mode", type: "enum", enumValues: ["fresh", "session"], description: "fresh（默认）：每次新 Agent 执行，有结论才投回本会话，没事可报时可以静默；session：到点提醒本会话自己做" },
        { name: "max_runs", type: "number", description: "最多触发几次，与 expires_in_hours 二选一必填" },
        { name: "expires_in_hours", type: "number", description: "多少小时后过期，与 max_runs 二选一必填" },
      ],
    },
    schedule_list: { summary: "列出本会话名下的 AI 排程（id、进度、过期时间）。", params: [] },
    schedule_cancel: {
      summary: "取消本会话名下的一个 AI 排程。",
      params: [{ name: "id", required: true, type: "string", description: "排程 id（来自 schedule_list）" }],
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
      summary: "管理全局定时任务（和设置页里的一样）。不是「给当前会话定时」：那用 schedule_create。",
      notes: "新建时所属通道默认是调用者所在的通道。independent=false 投给所属通道的主会话（飞书/微信通道的主会话回复会发到 IM，不一定是调用者当前所在的会话）。创建 / 修改 / 启用后返回任务实际的去向。",
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
        { name: "independent", type: "boolean", description: "add 默认 true：每次由全新 Agent 执行；false：任务内容投给所属通道的主会话，占用该会话上下文（飞书/微信通道的主会话回复会发到 IM）" },
        { name: "notify", type: "enum", enumValues: ["none", "agent", "im"], description: "独立运行的结果通知方式（非独立运行无效）：none 不通知 / agent 投进所属通道的主会话 / im 发到所属通道的主用户私聊（add 默认 im）" },
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

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
      summary: "管理项目和项目相关的全部配置（仅主用户）：建 / 查 / 改 / 归档 / 删项目，常用代码仓库，项目模板，项目存放位置、Git 基本原则、GitLab。用户用自然语言说就行，不用去设置页。",
      notes: "AI 拿不准怎么做时先 action=help：里面有概念、建项目的完整流程、怎么引导新手用户、各项配置怎么做，不带 topic 时还会列出当前配了什么、还缺什么。GitLab Token 等密钥只显示打码，AI 不会回显。改模板只影响之后新建的项目（已建项目有自己的快捷操作副本，可用 sync_steps 同步）。\n创建流程：先 templates 看模板和必填项（要接代码再 repos），按用户的话整理参数，信息不够就问；创建前把内容发给用户确认，确认后再 create。create 必须指定 chat_mode（没有默认值，不给会报错），用户没说清楚就先问他：group 建飞书独立群并把用户拉入群，bind 绑定已有飞书群，inline 不建群、项目绑在当前聊天上；群模式只有飞书私聊能用，应用内和微信只能 inline。建完不会进入项目会话（当前对话不受影响）：inline 的项目用户需要时自己进入（应用里在项目列表点开，飞书/微信里发 /p use <项目 ID>），群里的项目到群里协作。应用内、飞书、微信的主用户私聊都可以用。",
      params: [
        {
          name: "action",
          required: true,
          type: "enum",
          enumValues: [
            "help", "list", "get", "create", "update", "archive", "delete", "sync_steps",
            "templates", "template_save", "template_delete", "repos", "repo_save", "repo_remove", "settings", "settings_set",
          ],
          description: "help：操作手册（先读）。list / get：列出项目 / 看一个项目。create：创建项目。update：改项目资料。archive：归档或取消归档。delete：删除项目（删除前须向用户确认）。sync_steps：把项目的快捷操作同步成模板最新版。templates：列出项目模板（给 template_id 看详情）。template_save / template_delete：新建或修改 / 删除模板。repos：列出常用代码仓库。repo_save / repo_remove：登记或修改 / 移除仓库。settings / settings_set：查看 / 修改项目设置。",
        },
        { name: "topic", type: "enum", enumValues: ["overview", "create", "repos", "templates", "settings", "manage"], description: "help 可选：不给是总览（含建项目完整流程和当前状态），其余是各块细节" },
        { name: "project_id", type: "string", description: "get / update / archive / sync_steps / delete 必填：项目 ID" },
        { name: "archived", type: "boolean", description: "archive 必填：true 归档，false 取消归档" },
        { name: "name", type: "string", description: "create 必填：项目名称；update：新名称" },
        { name: "template_id", type: "string", description: "create 必填：模板 ID（先用 templates 查）；template_save 修改 / template_delete / templates 看详情时也用它" },
        { name: "action_id", type: "string", description: "templates 带 template_id 时可选：看某个快捷操作的提示词全文" },
        { name: "goal", type: "string", description: "create 可选：项目目标；update：新目标" },
        { name: "fields", type: "object", description: "create：模板要填的信息，键是字段名、值是内容，必填项必须给；update：项目信息键值，合并写入，值为空字符串删掉这一项" },
        { name: "repo", type: "object", description: "repo_save / repo_remove：{ repo_path, base_branch?, test_branch?, develop_branch?, clone? }。基线分支本地仓库不给会自动识别，远程必须给；clone 默认 true" },
        { name: "template", type: "object", description: "template_save：{ name, description?, needs_repo?, work_branch?, fields?[{label, placeholder?, required?, multiline?}], actions?[{id?, label, prompt?}] }。新建 name 必填；修改只给要改的项，fields / actions 给了就是完整新列表" },
        { name: "settings", type: "object", description: "settings_set：{ worktree_root?, git_principles?, reset_git_principles?, gitlab_host?, gitlab_token?, flow_hub_url?, flow_hub_token?, flow_hub_author? }，只给要改的项，空字符串表示清空 / 关闭 / 恢复默认" },
        { name: "repos", type: "object[]", description: "create 可选：要接入的代码仓库，每项 { repo_path, base_branch }；只有接代码仓库的模板才有效" },
        { name: "work_branch", type: "enum", enumValues: ["new", "base", "test", "develop"], description: "create 可选：克隆副本停在哪个分支；不给用模板默认" },
        { name: "feature_branch", type: "string", description: "create 可选：work_branch 为 new 时的分支名，不填自动生成" },
        { name: "story_url", type: "string", description: "create 可选：项目链接" },
        { name: "related_docs", type: "string", description: "create 可选：相关文档" },
        { name: "folder", type: "string", description: "create 可选：用已有文件夹当项目目录（绝对路径），只有不接代码仓库的模板可用" },
        { name: "chat_mode", type: "enum", enumValues: ["group", "bind", "inline"], description: "create 必填，没有默认值：group 建飞书独立群并拉用户入群，bind 绑定已有飞书群，inline 不建群、绑在当前聊天；应用内和微信只能 inline" },
        { name: "existing_group_chat_id", type: "string", description: "chat_mode 为 bind 时必填：要绑定的飞书群 chat_id（oc_ 开头），机器人要已经在群里" },
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

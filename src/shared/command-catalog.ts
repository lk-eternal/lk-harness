// ── 指令清单（Daemon 判定/帮助与应用内对话的 `/` 菜单共用）──────────────

export const COMMANDS: Record<string, string> = {
  "/stop": "停止当前运行中的 Agent（/stop -c 顺带清除当前会话排队消息）",
  "/x": "同 /stop",
  "/f": "打断当前对话并带新指示重开（/f <内容>）",
  "/status": "查看 Agent / Daemon 状态",
  "/s": "同 /status",
  "/list": "查看消息队列列表（不消费）",
  "/ls": "同 /list",
  "/task": "定时任务（/task 查看子命令说明；如 /task ls）",
  "/t": "同 /task",
  "/project": "项目工作区（/project 查看；/p new|ls|use|plan|build|review|ship|sync）",
  "/p": "同 /project",
  "/model": "Agent 模型（/model ls | info | set <序号>）",
  "/m": "同 /model",
  "/mcp": "MCP 服务器管理（/mcp ls | info | enable | disable | delete | add）",
  "/mc": "同 /mcp",
  "/chat": "会话管理（/c ls | /c w 切换目录 | /c <序号> | /c new <描述>）",
  "/c": "同 /chat",
  "/group": "群聊开通（在群里 /group allow 开通本群 | deny 关闭本群 | ls 查看已开通的群）",
  "/clean": "清空消息队列",
  "/cl": "同 /clean",
  "/reset": "下次拉起 Agent 时不 resume 旧会话（新 SDK 会话），不删除本地文件",
  "/r": "同 /reset",
  "/restart": "停止 Agent + 清空队列 + 重启 Daemon",
  "/rr": "同 /restart",
  "/help": "显示可用指令列表",
  "/h": "同 /help",
};

/** 菜单用：去掉"同 /xxx"的别名项，只留主指令 */
export function primaryCommands(): { cmd: string; desc: string }[] {
  return Object.entries(COMMANDS)
    .filter(([, desc]) => !desc.startsWith("同 "))
    .map(([cmd, desc]) => ({ cmd, desc }));
}

/**
 * 输入框里 `/` 指令菜单的查询词：只在输入的是「/指令」本身（尚未出现空格）时有值，
 * 否则返回 null（不显示菜单）。小写化，匹配不区分大小写。桌面和手机端输入框共用。
 */
export function slashQueryOf(text: string): string | null {
  return /^\/[^\s]*$/.test(text) ? text.toLowerCase() : null;
}

/** 只在飞书里有意义的指令（应用内对话没有群）：Daemon 照常认，但不进输入框的 `/` 菜单 */
export const FEISHU_ONLY_COMMANDS: ReadonlySet<string> = new Set(["/group"]);

/**
 * 带图片发出时仍然当指令处理的指令：只有 `/f`——它把后面的内容当新指示交给 Agent，图片也要跟着过去。
 * 别的指令用不上图片，带图发出时仍按普通消息处理（图片交给 Agent），行为和以前一致。
 */
export const IMAGE_CARRYING_COMMANDS: ReadonlySet<string> = new Set(["/f"]);

/** 输入的第一个词（小写）是不是带图也算指令的那几个 */
export function isImageCarryingCommand(text: string): boolean {
  return IMAGE_CARRYING_COMMANDS.has(text.trim().split(/\s+/)[0]?.toLowerCase() ?? "");
}

/**
 * 带图片的指令交给指令队列的那一行文本。
 * 指令队列里只有一行文本、没有图片字段；飞书里图文混排的指令也是这样——图片的
 * `[图片已保存: …]` 标记直接跟在指令文本后面，由主进程的 `/f` 原样交给 Agent。这里沿用同一个约定。
 * 标记之间、标记和正文之间只用一个空格：主进程会按空白切词再用单个空格拼回去。
 */
export function commandTextWithImages(text: string, images: readonly string[]): string {
  return [text.trim(), ...images.map((p) => `[图片已保存: ${p}]`)].join(" ");
}

/** 输入框的指令菜单候选：单个 `/` 给全部主指令（去掉只属于飞书的），继续输入按前缀过滤；不是指令输入时为空 */
export function slashMenuItems(text: string): { cmd: string; desc: string }[] {
  const q = slashQueryOf(text);
  return q === null ? [] : primaryCommands().filter((c) => !FEISHU_ONLY_COMMANDS.has(c.cmd) && c.cmd.startsWith(q));
}

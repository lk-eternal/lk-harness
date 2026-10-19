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

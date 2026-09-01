/**
 * 日志全文落盘；UI 展示时将 sessionKey 替换为友好标签（项目名/会话名）。
 * 匹配必须带 ch_ 前缀，避免误替换路径中的 oc_ 片段。
 */

/** sessionKey 在日志行中的形态（须 ch_ 开头，避免误匹配路径内 oc_） */
const SESSION_KEY_IN_LOG_RE =
  /ch_[a-zA-Z0-9]+\|[^|\s]+(?:::(?:project_[a-f0-9]+|temp_[^\s\]]+|wf_[^\s\]]+|[A-Za-z]:[^\s\]]*))?/g

/** 从完整 sessionKey 生成 UI 短标签（无项目名/页签信息时的兜底） */
export function shortenSessionKeyForUi(sessionKey: string): string {
  const sk = sessionKey.trim()
  const proj = sk.match(/::project_([a-f0-9]+)/i)
  if (proj) return `📦 ${proj[1].slice(0, 8)}`

  const sep = sk.indexOf("::")
  if (sep >= 0) {
    const suffix = sk.slice(sep + 2)
    if (/[\\/]/.test(suffix)) {
      const base = suffix.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || suffix
      return `📂 ${base}`
    }
    if (suffix.startsWith("temp_")) return `⏳ temp:${suffix.slice(5, 13)}`
    if (suffix.startsWith("wf_")) return `⏳ wf:${suffix.slice(3, 11)}`
  }

  const chatPart = sk.includes("|") ? sk.slice(sk.indexOf("|") + 1) : sk
  const chat = (chatPart.split("::")[0] || chatPart).slice(0, 14)
  return chat
}

/** 日志里 `[taskId]` 形态（UUID 或含连字符的 slug，避免误匹配 [SDK]/[Agent]） */
const BRACKETED_TASK_SESSION_RE =
  /\[([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[a-z][a-z0-9]*(?:-[a-z0-9-]+)+)\]/gi

/** 日志 UI 展示：sessionKey → 友好标签，其它内容（含完整路径）不动 */
export function formatLogLineForUi(
  line: string,
  resolveLabel?: (sessionKey: string) => string | undefined,
): string {
  const replaceTaskBracket = (s: string) =>
    s.replace(BRACKETED_TASK_SESSION_RE, (full, id: string) => {
      const label = resolveLabel?.(id)
      if (!label) return full
      return `[${label}]`
    })

  // Prompt / worker 回合日志含 session_key 与长 result，不可做缩短替换
  if (/(?:启动|恢复|worker 回合) Prompt:/.test(line) || /worker 回合结束/.test(line)) return replaceTaskBracket(line)

  const withChatKeys = line.replace(
    SESSION_KEY_IN_LOG_RE,
    (sk) => resolveLabel?.(sk) || shortenSessionKeyForUi(sk),
  )
  return replaceTaskBracket(withChatKeys)
}

/** 将 Dashboard sessionTabs 的 label/kind 转成紧凑标签（图标 + 名，不含分支） */
export function cardLabelFromSessionTab(tab: {
  kind: string
  label: string
}): string {
  if (tab.kind === "project") {
    const name = tab.label.split(" · ")[0]?.trim() || tab.label
    return `📦 ${name}`
  }
  if (tab.kind === "main" || tab.kind === "dir") {
    const name = tab.label.replace("（主）", "").split(" · ")[0]?.trim() || tab.label
    return `📂 ${name}`
  }
  if (tab.kind === "temp") return `⏳ ${tab.label}`
  if (tab.kind === "task") return tab.label.startsWith("⏰") ? tab.label : `⏰ ${tab.label}`
  return tab.label
}

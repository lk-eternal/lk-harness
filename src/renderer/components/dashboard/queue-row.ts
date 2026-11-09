/**
 * 工作台「消息队列」一行上的通道徽标和会话名怎么定（纯逻辑，界面只管画）。
 *
 * 会话名有两个来源：
 * - 会话树（工作台自己拼的）：主用户自己的会话、项目、任务一直在树里；
 *   但别人的私聊和群只有「正在运行」时才在树里，会话一空闲就没了。
 * - 主进程随消息一起给的 sessionLabel / channelName / audience，只取决于消息本身，不取决于会话此刻在不在运行。
 *
 * 别人的会话如果跟着树走，Agent 一起一停，这一行就在「通道 + 对方的名字」和一个兜底写法之间来回换（闪），
 * 兜底写法还会把别人的私聊标成「（主）」。所以别人的会话只认主进程给的。
 * 主用户自己的会话沿用树里的名字（应用内会话在树里叫摘要标题，和对话页一致），树里没有才退回主进程的标签。
 */
export interface QueueRowSource {
  sessionLabel?: string
  channelName?: string
  /** others = 别人的会话（私聊他人、群）；旧版主进程不带这个字段 */
  audience?: "main" | "others"
}

export interface QueueRowTreeMeta {
  channelName: string
  label: string
}

export function queueRowView(
  msg: QueueRowSource,
  tree: QueueRowTreeMeta | undefined,
  fallbackLabel: () => string,
): { channelName?: string; label: string } {
  const channelName = msg.channelName ?? tree?.channelName
  if (msg.audience === "others" && msg.sessionLabel) return { channelName, label: msg.sessionLabel }
  return { channelName, label: tree?.label ?? fallbackLabel() }
}

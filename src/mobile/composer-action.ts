/**
 * 输入栏右侧按钮是「发送」还是「停止」。
 * Agent 在干活时：输入框空着就是「停止」；已经写了内容（或带了图片）就是「发送」，消息进暂存区排队，当前回合结束后自动发出。
 * 和电脑端输入框一致。之前干活时一律显示停止、回车也被拦掉，手机上没法给运行中的 Agent 排队发消息。
 */
export function composerAction(busy: boolean, hasContent: boolean): "send" | "stop" {
  return busy && !hasContent ? "stop" : "send"
}

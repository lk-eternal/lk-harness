import type { MessageChannel } from "./channel-types.js"

/**
 * 对话页要用「应用内对话」通道。没有就自动建一个，用户不用先去设置里添加。
 *
 * 只有「一个应用内通道都没有」才建。已有但被用户停用的不动：停用是用户明确做的选择，
 * 对话页替他打开会和设置页打架；只告诉他是停用了，去设置里启用。
 */
export type AppChannelPlan =
  | { action: "ready" }
  | { action: "disabled"; channelId: string }
  | { action: "create" }

export function planAppChannel(channels: readonly Pick<MessageChannel, "id" | "type" | "enabled">[] | undefined): AppChannelPlan {
  const apps = (channels ?? []).filter((c) => c.type === "app")
  // 和对话页取通道的口径一致：enabled 缺省按启用算
  if (apps.some((c) => c.enabled !== false)) return { action: "ready" }
  if (apps.length > 0) return { action: "disabled", channelId: apps[0].id }
  return { action: "create" }
}

export interface EnsureAppChannelIO {
  /** 读当前已保存的全部通道（每次都读最新的，不用调用方手里的旧快照） */
  loadChannels(): Promise<MessageChannel[]>
  /** 整体写回通道列表 */
  saveChannels(next: MessageChannel[]): Promise<void>
  /** 造一个新的应用内通道（id、默认值由调用方决定） */
  newChannel(): MessageChannel
}

export type EnsureAppChannelResult =
  | { status: "ready" }
  | { status: "disabled" }
  | { status: "created"; channelId: string }
  | { status: "failed"; error: string }

/**
 * 保证有一个应用内通道。读 → 判断 → 追加写回，不抛错：失败当作 failed 返回，由界面决定怎么提示。
 * 新通道追加在已有通道后面，其它通道原样保留。
 */
export async function ensureAppChannel(io: EnsureAppChannelIO): Promise<EnsureAppChannelResult> {
  try {
    const channels = await io.loadChannels()
    const plan = planAppChannel(channels)
    if (plan.action === "ready") return { status: "ready" }
    if (plan.action === "disabled") return { status: "disabled" }
    const channel = io.newChannel()
    await io.saveChannels([...channels, channel])
    return { status: "created", channelId: channel.id }
  } catch (e: unknown) {
    return { status: "failed", error: e instanceof Error ? e.message : String(e) }
  }
}

/** 对话页里没有可用的应用内通道时，界面上说什么 */
export type AppChannelIssue = { kind: "disabled" } | { kind: "failed"; error: string }

export function describeAppChannelIssue(issue: AppChannelIssue | null): { message: string; settingsLabel: string } {
  if (issue?.kind === "disabled") {
    return { message: "「应用内对话」通道已停用", settingsLabel: "去设置里启用" }
  }
  if (issue?.kind === "failed") {
    return { message: `自动创建「应用内对话」通道失败：${issue.error}（稍后会自动重试）`, settingsLabel: "去设置里添加" }
  }
  return { message: "还没有「应用内对话」通道", settingsLabel: "去设置里添加" }
}

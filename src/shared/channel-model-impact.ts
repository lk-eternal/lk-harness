import type { ManagedSession } from "./managed-sessions.js"

/**
 * 保存通道里「其他人」的默认模型 / 供应商（或者主用户的、而其他人跟随它）时，对已有的别人的会话有什么影响。
 * 只有类型和纯函数，没有运行时依赖：主进程用它整理清单，渲染进程用它拼提示文案。
 *
 * 只管「其他人」的会话：主用户的、项目、任务、临时会话一律不碰（清单里它们 audience 是 main 或不可管）。
 */

export interface ImpactDefault {
  resourceId: string
  resourceName: string
  model: string
  modelParams: string
}

export interface ImpactBucket {
  total: number
  running: number
}

export interface ChannelModelImpact {
  /** 其他人的默认供应商 / 模型真的变了 */
  changed: boolean
  oldDefault: ImpactDefault
  newDefault: ImpactDefault
  providerChanged: boolean
  /** 这个通道里其他人的会话总数（只算可管理的） */
  total: number
  /** 没单独设置过模型 / 供应商的：保存后下一条消息起自动用新默认 */
  following: ImpactBucket
  /** 只单独改过模型（供应商跟着通道）的：不会跟着变，可以一键清掉 */
  modelPinned: ImpactBucket
  /** 单独指定了供应商的：那是有意的选择，不会变，也不提供清除 */
  providerPinned: ImpactBucket
}

/** 会影响「其他人默认用哪个供应商 / 模型」的通道字段（主用户的也算：其他人留空时跟随它们） */
export const CHANNEL_MODEL_FIELDS = [
  "agentResourceId",
  "model",
  "modelParams",
  "othersAgentResourceId",
  "othersModel",
  "othersModelParams",
] as const
export type ChannelModelField = (typeof CHANNEL_MODEL_FIELDS)[number]

/**
 * 保存其他途径（绑定主用户、发测试消息这类「先落库」）时，不把还没点「保存」的模型改动一起存进去：
 * 模型的改动只能走「保存」按钮，那里才会先看对其他人会话的影响。返回草稿，但模型相关字段取已保存的值。
 */
export function holdBackModelEdits<T extends Partial<Record<ChannelModelField, string>>>(draft: T, saved: T): T {
  const out = { ...draft }
  for (const f of CHANNEL_MODEL_FIELDS) {
    if (out[f] !== saved[f]) out[f] = saved[f]
  }
  return out
}

/** 通道里属于「其他人」、能在会话管理里管的会话 */
export function othersOfChannel(sessions: readonly ManagedSession[], channelId: string): ManagedSession[] {
  return sessions.filter((s) => s.channelId === channelId && s.audience === "others" && s.manageable)
}

const bucket = (list: readonly ManagedSession[]): ImpactBucket => ({
  total: list.length,
  running: list.filter((s) => s.running).length,
})

/** 按「会话自己改过什么」分三类，各自数个数和其中运行中的个数 */
export function bucketOthers(
  sessions: readonly ManagedSession[],
  channelId: string,
): { total: number; following: ImpactBucket; modelPinned: ImpactBucket; providerPinned: ImpactBucket } {
  const mine = othersOfChannel(sessions, channelId)
  return {
    total: mine.length,
    following: bucket(mine.filter(isFollowing)),
    modelPinned: bucket(mine.filter(isModelPinned)),
    providerPinned: bucket(mine.filter(isProviderPinned)),
  }
}

const isProviderPinned = (s: ManagedSession): boolean => s.resourceSource === "session"
/** 只改了模型：供应商跟着通道（会话里存的供应商恰好等于通道默认也算跟着），和「恢复默认」认的是同一类 */
const isModelPinned = (s: ManagedSession): boolean => s.resourceSource !== "session" && s.modelSource === "session"
const isFollowing = (s: ManagedSession): boolean => s.resourceSource !== "session" && s.modelSource !== "session"

/** 清除「单独改过的模型」时要动的会话：只改了模型、供应商跟着通道的（供应商是有意指定的不动） */
export function clearTargets(sessions: readonly ManagedSession[], channelId: string): ManagedSession[] {
  return othersOfChannel(sessions, channelId).filter(isModelPinned)
}

/**
 * 「停止会话」要停的：跟随默认、此刻正在运行的其他人的会话——它们是按旧默认拉起的，不停就一直用到结束。
 * 单独设置过的（改过模型 / 指定了供应商）不受默认变化影响，不在其中。
 * 要在保存和清除之后再算：这样刚被清掉设置的会话已经算「跟随默认」了。
 */
export function followingRunningKeys(sessions: readonly ManagedSession[], channelId: string): string[] {
  return othersOfChannel(sessions, channelId)
    .filter((s) => s.running && isFollowing(s))
    .map((s) => s.sessionKey)
}

/** 有没有值得问用户的：默认真的变了，并且有运行中的跟随会话可以停、或有单独改过模型的可以清 */
export function needsImpactPrompt(impact: ChannelModelImpact): boolean {
  return impact.changed && (impact.following.running > 0 || impact.modelPinned.total > 0)
}

export function defaultLabel(d: Pick<ImpactDefault, "resourceName" | "model">): string {
  return `${d.resourceName || "未配置供应商"} / ${d.model || "自动"}`
}

/** 勾「停止」时会停几个：跟随的运行中会话；同时勾了「清除」的话，被清掉设置的运行中会话也算 */
export function stopCount(impact: ChannelModelImpact, clearOverrides: boolean): number {
  return impact.following.running + (clearOverrides ? impact.modelPinned.running : 0)
}

/** 提示框正文里的几行说明 */
export function impactLines(impact: ChannelModelImpact): string[] {
  const lines = [`其他人的默认模型：${defaultLabel(impact.oldDefault)} → ${defaultLabel(impact.newDefault)}`]
  const { following, modelPinned, providerPinned } = impact
  if (following.total > 0) {
    lines.push(
      `没单独设置过的会话 ${following.total} 个：保存后下一条消息起用新默认` +
        (following.running > 0 ? `；其中 ${following.running} 个正在运行，要等它们结束或被停止后才会换` : ""),
    )
  }
  if (modelPinned.total > 0) lines.push(`单独改过模型的会话 ${modelPinned.total} 个：不会跟着变`)
  if (providerPinned.total > 0) lines.push(`单独指定了供应商的会话 ${providerPinned.total} 个：不会跟着变`)
  if (impact.providerChanged) lines.push("供应商也变了：换到新供应商的会话，之前的对话上下文可能不会延续")
  return lines
}

export function stopOptionText(impact: ChannelModelImpact, clearOverrides: boolean): string {
  return `停止正在运行的会话（${stopCount(impact, clearOverrides)} 个），它们的下一条消息会按新默认重新开始`
}

export function clearOptionText(impact: ChannelModelImpact): string {
  return `清除 ${impact.modelPinned.total} 个会话单独改过的模型，让它们也用新默认`
}

/** 保存完成后要告诉用户的结果；某一项是 undefined 表示没做（没勾 / 没问） */
export interface ImpactOutcome {
  /** 保存前的影响预览失败了（保存照常进行） */
  previewError?: string
  clear?: ChannelImpactClearResult
  stop?: ChannelImpactStopResult
}

function failureText(r: { ok: boolean; error?: string; failed: { error: string }[] }): string {
  if (r.failed.length > 0) {
    const reasons = [...new Set(r.failed.map((f) => f.error))].slice(0, 2).join("；")
    return `${r.failed.length} 个失败（${reasons}）`
  }
  return r.error ?? "未知错误"
}

/** 保存之后的结果说明，一项一行；什么都没做 / 没出问题就是空数组（不用弹窗） */
export function impactOutcomeLines(o: ImpactOutcome): string[] {
  const lines: string[] = []
  if (o.previewError) {
    lines.push(`没能检查这次改动对其他人会话的影响（${o.previewError}）。设置已保存，正在运行的会话要等它们结束后才会用新默认。`)
  }
  if (o.clear) {
    const c = o.clear
    const failed = c.ok && c.failed.length === 0 ? "" : failureText(c)
    if (c.cleared > 0 || failed) {
      lines.push(`单独改过的模型：已清除 ${c.cleared} 个${failed ? `，${failed}；失败的仍沿用自己设置的模型` : ""}`)
    }
  }
  if (o.stop) {
    const s = o.stop
    const failed = s.ok && s.failed.length === 0 ? "" : failureText(s)
    if (s.stopped > 0 || failed) {
      lines.push(`正在运行的会话：已停止 ${s.stopped} 个${failed ? `，${failed}；失败的要等它们自己结束后才会用新默认` : ""}`)
    }
  }
  return lines
}

// ── 主进程 ↔ 界面之间的返回形状 ───────────────────────────

export interface ChannelImpactPreviewResult {
  ok: boolean
  error?: string
  /** 通道还没保存过（新建）时没有 */
  impact?: ChannelModelImpact
}

export interface ChannelImpactClearResult {
  ok: boolean
  error?: string
  cleared: number
  failed: { sessionKey: string; error: string }[]
}

export interface ChannelImpactStopResult {
  ok: boolean
  error?: string
  stopped: number
  failed: { sessionKey: string; error: string }[]
}

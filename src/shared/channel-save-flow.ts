import {
  impactOutcomeLines,
  needsImpactPrompt,
  type ChannelImpactClearResult,
  type ChannelImpactPreviewResult,
  type ChannelImpactStopResult,
  type ChannelModelImpact,
  type ImpactOutcome,
} from "./channel-model-impact.js"

/** 提示框里用户的选择：两项默认都不勾，不勾就只保存 */
export interface ImpactChoice {
  clear: boolean
  stop: boolean
}

export interface ChannelSaveFlowDeps {
  /** 保存前预览：其他人的默认会不会变、影响几个会话 */
  preview: (channelId: string, draft: unknown) => Promise<ChannelImpactPreviewResult>
  /** 问用户；返回 null = 取消 */
  ask: (impact: ChannelModelImpact) => Promise<ImpactChoice | null>
  clear: (channelId: string) => Promise<ChannelImpactClearResult>
  stop: (channelId: string) => Promise<ChannelImpactStopResult>
}

export interface ChannelSaveResult {
  /** false = 用户在提示框里取消了；真正的保存（persist）没有调用 */
  saved: boolean
  /** 取消了，并且调用过 onCancel 做兜底的保存 */
  cancelled: boolean
  /** 保存之后要告诉用户的话；空数组 = 没有可说的，不用弹窗 */
  lines: string[]
}

/** 清除 / 停止：抛异常也不拦保存，折成一个失败结果，保存完一并告诉用户 */
async function runStep<T extends { ok: boolean; error?: string; failed: unknown[] }>(
  call: () => Promise<T>,
  empty: Omit<T, "ok" | "error" | "failed">,
): Promise<T> {
  try {
    return await call()
  } catch (e) {
    return { ...empty, ok: false, error: e instanceof Error ? e.message : String(e), failed: [] } as unknown as T
  }
}

/**
 * 保存通道前后对「其他人已有会话」的处理。设置页和引导向导的保存共用这一份，两边的行为才不会分叉：
 *
 * 1. 预览：其他人的默认模型 / 供应商真的变了，并且有值得问的会话（运行中的跟随会话、单独改过模型的），才问用户；
 *    预览失败不拦保存，记下来保存后告诉用户。
 * 2. 取消 → persist 不调用，什么都不动。向导里取消不能把别的设置（刚扫出来的凭据）丢掉，
 *    由调用方给 onCancel 保存「模型字段保持原样」的那一版。
 * 3. 先清除、再保存、最后停止：清除要按旧的通道配置做（保存后默认变了，就认不出遗留的供应商了）；
 *    停止要在保存之后（它们的下一条消息才会按新默认拉起）。清除或停止失败都不拦保存。
 *
 * persist 抛的异常照常抛给调用方：保存本身失败不是「影响」的事。
 */
export async function saveChannelWithImpact(
  channelId: string,
  draft: unknown,
  deps: ChannelSaveFlowDeps,
  persist: () => Promise<void>,
  onCancel?: () => Promise<void>,
): Promise<ChannelSaveResult> {
  const outcome: ImpactOutcome = {}
  const choice = await askImpact(channelId, draft, deps, outcome)
  if (!choice) {
    await onCancel?.()
    return { saved: false, cancelled: true, lines: [] }
  }
  if (choice.clear) outcome.clear = await runStep(() => deps.clear(channelId), { cleared: 0 })
  await persist()
  if (choice.stop) outcome.stop = await runStep(() => deps.stop(channelId), { stopped: 0 })
  return { saved: true, cancelled: false, lines: impactOutcomeLines(outcome) }
}

async function askImpact(
  channelId: string,
  draft: unknown,
  deps: ChannelSaveFlowDeps,
  outcome: ImpactOutcome,
): Promise<ImpactChoice | null> {
  const none: ImpactChoice = { clear: false, stop: false }
  try {
    const r = await deps.preview(channelId, draft)
    if (!r.ok) {
      outcome.previewError = r.error ?? "未知错误"
      return none
    }
    if (!r.impact || !needsImpactPrompt(r.impact)) return none
    return await deps.ask(r.impact)
  } catch (e) {
    outcome.previewError = e instanceof Error ? e.message : String(e)
    return none
  }
}

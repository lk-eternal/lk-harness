/**
 * 暂存区「立即发送」之后的交接提示。
 * 点下去到排队的消息被 Agent 领走之间有几秒空档（取消当前回合要 2~3 秒；万一要重新拉起 Agent 更久），
 * 界面不说话用户会以为没点上而重复点。这里只管「此刻该显示什么」，不碰任何状态。
 */

/** 主进程 sendQueuedNow 的返回（只用到这两个字段） */
export interface SendQueuedNowReply {
  ok: boolean
  via?: "soft" | "launching" | "relaunch" | "hard"
}

/**
 * - soft：已打断当前回合，Agent 没重启，马上会领走排队的消息
 * - starting：Agent 要（重新）启动，启动后才会领走
 * - none：没发出去或不认识的返回，不显示交接提示
 */
export type SendNowOutcome = "soft" | "starting" | "none"

export function sendNowOutcome(r: SendQueuedNowReply): SendNowOutcome {
  if (!r.ok) return "none"
  if (r.via === "soft") return "soft"
  if (r.via === "launching" || r.via === "relaunch" || r.via === "hard") return "starting"
  return "none"
}

/** null = 没有进行中的交接，显示平时的排队提示 */
export type HandoffPhase = "interrupting" | SendNowOutcome | null

/** 交接提示最多显示这么久：Agent 一直没领走（比如启动失败）时不能永远挂着「正在启动」 */
export const HANDOFF_HINT_MAX_MS = 30_000

export function queuedHeaderText(count: number, phase: HandoffPhase): string {
  switch (phase) {
    case "interrupting": return `正在打断当前回合… · ${count} 条`
    case "soft": return `已打断，Agent 马上处理 · ${count} 条`
    case "starting": return `Agent 正在启动，启动后马上处理 · ${count} 条`
    default: return `排队中 · ${count} 条，Agent 完成当前回合后自动发出`
  }
}

/** IPC 返回后进入哪个提示阶段：none 回到平时的提示 */
export function phaseAfterSend(outcome: SendNowOutcome): HandoffPhase {
  return outcome === "none" ? null : outcome
}

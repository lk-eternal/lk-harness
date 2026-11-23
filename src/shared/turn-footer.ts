// ── 回合页脚：飞书流式卡和应用内聊天共用 ─────────────────────────
// 页脚有哪几项、什么顺序、什么情况下出现，只在这里定；两端各自只管把它画出来
// （飞书拼成 notation 小字，应用内拼成 span）。顺序固定：模型 · 状态 · 耗时 · 时间。

/** 回合没有正常完成时的状态；正常完成不传 */
export type TurnFooterStatus = "running" | "interrupted"

export type TurnFooterPart =
  | { kind: "model"; text: string }
  | { kind: "status"; status: TurnFooterStatus; text: string }
  | { kind: "elapsed"; text: string }
  | { kind: "time"; ts: number }

const TURN_STATUS_TEXT: Record<TurnFooterStatus, string> = {
  running: "运行中…",
  interrupted: "已中断",
}

/** 回合耗时：取整秒，至少 1s。12s、2m9s、整分 2m、1h5m（满一小时不再带秒） */
export function formatTurnDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest ? `${m}m${rest}s` : `${m}m`
  const minutes = m % 60
  return `${Math.floor(m / 60)}h${minutes ? `${minutes}m` : ""}`
}

/**
 * 缺的项直接不出现：没有模型名、没传耗时（或耗时为负）、没传时间，对应的一项就不在结果里。
 * time 是时间戳，怎么显示由两端各自决定（飞书只写 HH:mm，应用内带日期和悬停提示）。
 */
export function buildTurnFooter(input: {
  modelLabel?: string
  status?: TurnFooterStatus
  elapsedMs?: number
  time?: number
}): TurnFooterPart[] {
  const parts: TurnFooterPart[] = []
  const model = input.modelLabel?.trim()
  if (model) parts.push({ kind: "model", text: model })
  if (input.status) parts.push({ kind: "status", status: input.status, text: TURN_STATUS_TEXT[input.status] })
  if (input.elapsedMs !== undefined && input.elapsedMs >= 0) {
    parts.push({ kind: "elapsed", text: `耗时 ${formatTurnDuration(input.elapsedMs)}` })
  }
  if (input.time !== undefined) parts.push({ kind: "time", ts: input.time })
  return parts
}

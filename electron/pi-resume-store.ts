import { app } from "electron"
import {
  initSessionOverridesStore,
  patchSessionRecord,
  getSessionRecord,
  clearSessionRecordFields,
  RESUME_ENTRY_TTL_MS,
} from "../src/shared/session-overrides-store.js"

// Pi 的会话本身存在 Pi 自己的账本文件里；会话记录里只留「最近一次飞书流式卡 cardId」，
// 进程重启后用于 Resume 前收口孤儿卡，避免再建一张重复卡。

function ensureStore(): void {
  const dir = process.env.APP_DATA_DIR?.trim() || app.getPath("userData")
  initSessionOverridesStore(dir)
}

/** 上次留下、还没收口的流式卡 cardId；超过保留期的不算 */
export function getPiStreamCardId(sessionKey: string): string | undefined {
  ensureStore()
  const e = getSessionRecord(sessionKey)
  if (!e?.streamCardId) return undefined
  if (Date.now() - (e.updatedAt ?? 0) >= RESUME_ENTRY_TTL_MS) return undefined
  return e.streamCardId
}

export function patchPiResumableStreamCard(
  sessionKey: string,
  streamCardId: string | undefined,
  opts?: { onlyIf?: string },
): void {
  ensureStore()
  const e = getSessionRecord(sessionKey)
  // 清除必须带期望值：延迟 finish 的清理不能抹掉新回合刚记录的新卡
  if (opts?.onlyIf && e?.streamCardId !== opts.onlyIf) return
  if (e?.streamCardId === streamCardId) return
  patchSessionRecord(sessionKey, { streamCardId })
}

export function forgetPiResumable(sessionKey: string): void {
  ensureStore()
  clearSessionRecordFields(sessionKey, ["streamCardId"])
}

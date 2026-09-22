import { app } from "electron"
import {
  initSessionOverridesStore,
  patchSessionRecord,
  getSessionRecord,
  clearSessionRecordFields,
  RESUME_ENTRY_TTL_MS,
} from "../src/shared/session-overrides-store.js"

export interface PiResumeEntry {
  rulesHash: string
  daemonPort?: number
  /** 最近一次飞书流式卡 cardId；进程重启后用于 Resume 前收口孤儿卡 */
  streamCardId?: string
  updatedAt: number
}

function ensureStore(): void {
  const dir = process.env.APP_DATA_DIR?.trim() || app.getPath("userData")
  initSessionOverridesStore(dir)
}

export function getPiResumable(sessionKey: string): PiResumeEntry | undefined {
  ensureStore()
  const e = getSessionRecord(sessionKey)
  if (!e?.rulesHash) return undefined
  if (Date.now() - (e.updatedAt ?? 0) >= RESUME_ENTRY_TTL_MS) return undefined
  return {
    rulesHash: e.rulesHash,
    daemonPort: e.daemonPort,
    streamCardId: e.streamCardId,
    updatedAt: e.updatedAt,
  }
}

export function rememberPiResumable(
  sessionKey: string,
  rulesHash: string,
  daemonPort?: number,
  streamCardId?: string,
): void {
  ensureStore()
  const prev = getSessionRecord(sessionKey)
  patchSessionRecord(sessionKey, {
    rulesHash,
    daemonPort,
    streamCardId: streamCardId ?? prev?.streamCardId,
  })
}

export function patchPiResumableStreamCard(
  sessionKey: string,
  streamCardId: string | undefined,
  opts?: { onlyIf?: string },
): void {
  ensureStore()
  const e = getSessionRecord(sessionKey)
  if (!e?.rulesHash) return
  if (opts?.onlyIf && e.streamCardId !== opts.onlyIf) return
  if (e.streamCardId === streamCardId) return
  patchSessionRecord(sessionKey, { streamCardId })
}

export function forgetPiResumable(sessionKey: string): void {
  ensureStore()
  clearSessionRecordFields(sessionKey, ["rulesHash", "daemonPort", "streamCardId"])
}

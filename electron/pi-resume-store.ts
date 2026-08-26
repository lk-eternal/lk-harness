import { app } from "electron"
import { join } from "node:path"
import { readFileSync, writeFileSync } from "node:fs"

export interface PiResumeEntry {
  rulesHash: string
  daemonPort?: number
  /** 最近一次飞书流式卡 cardId；进程重启后用于 Resume 前收口孤儿卡 */
  streamCardId?: string
  updatedAt: number
}

const ENTRY_TTL_MS = 14 * 24 * 60 * 60 * 1000
let store: Map<string, PiResumeEntry> | null = null

function storePath(): string {
  return join(app.getPath("userData"), "pi-resume-map.json")
}

function loadStore(): Map<string, PiResumeEntry> {
  if (store) return store
  store = new Map()
  try {
    const raw = JSON.parse(readFileSync(storePath(), "utf8")) as Record<string, PiResumeEntry>
    const now = Date.now()
    for (const [key, e] of Object.entries(raw)) {
      if (e?.rulesHash && now - (e.updatedAt ?? 0) < ENTRY_TTL_MS) {
        store.set(key, e)
      }
    }
  } catch { /* first run or corrupt file */ }
  return store
}

function saveStore(): void {
  if (!store) return
  try {
    writeFileSync(storePath(), JSON.stringify(Object.fromEntries(store)), "utf8")
  } catch { /* best-effort */ }
}

export function getPiResumable(sessionKey: string): PiResumeEntry | undefined {
  return loadStore().get(sessionKey)
}

export function rememberPiResumable(
  sessionKey: string,
  rulesHash: string,
  daemonPort?: number,
  streamCardId?: string,
): void {
  const prev = loadStore().get(sessionKey)
  loadStore().set(sessionKey, {
    rulesHash,
    daemonPort,
    streamCardId: streamCardId ?? prev?.streamCardId,
    updatedAt: Date.now(),
  })
  saveStore()
}

export function patchPiResumableStreamCard(
  sessionKey: string,
  streamCardId: string | undefined,
  opts?: { onlyIf?: string },
): void {
  const e = loadStore().get(sessionKey)
  if (!e) return
  if (opts?.onlyIf && e.streamCardId !== opts.onlyIf) return
  if (e.streamCardId === streamCardId) return
  e.streamCardId = streamCardId
  e.updatedAt = Date.now()
  saveStore()
}

export function forgetPiResumable(sessionKey: string): void {
  if (loadStore().delete(sessionKey)) saveStore()
}

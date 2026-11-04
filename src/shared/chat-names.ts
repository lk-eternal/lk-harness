import * as fs from "node:fs"
import * as path from "node:path"

/**
 * 聊天名 / 用户名的两块基础件，都不依赖 Electron：
 *  - ChatNameBook：聊天键 → 名字，落盘。别人的会话在磁盘上只有一串 id，名字只能问飞书；
 *    不落盘的话，重启后每个空闲会话都要重新问，而私聊对方的 open_id 没存在任何地方，重启后就再也认不出是谁了。
 *  - createChatNameFetcher：向 daemon 批量要群名。分批、失败后冷却、同一个群不重复问，
 *    这样会话清单可以放心在后台为每个群补名字，而不会把一次几十个群的请求拖到超时、也不会每轮轮询都打飞书接口。
 */

const NAME_MAX_CHARS = 100

export interface ChatNameBook {
  get(chatKey: string): string | undefined
  /** 有变化才写盘；返回有没有变化。空名字 / 非字符串忽略 */
  setMany(entries: Readonly<Record<string, string | undefined>>): boolean
}

function cleanName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const t = v.replace(/\s+/g, " ").trim()
  return t ? t.slice(0, NAME_MAX_CHARS) : undefined
}

export function createChatNameBook(file: string): ChatNameBook {
  let names: Map<string, string> | null = null

  const load = (): Map<string, string> => {
    if (names) return names
    names = new Map()
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { names?: Record<string, unknown> }
      for (const [k, v] of Object.entries(raw?.names ?? {})) {
        const n = cleanName(v)
        if (k && n) names.set(k, n)
      }
    } catch { /* 没有 / 损坏：当成空的，下次有新名字时重写 */ }
    return names
  }

  return {
    get: (chatKey) => load().get(chatKey),
    setMany(entries) {
      const map = load()
      let changed = false
      for (const [k, v] of Object.entries(entries)) {
        const n = cleanName(v)
        if (!k || !n || map.get(k) === n) continue
        map.set(k, n)
        changed = true
      }
      if (!changed) return changed
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = file + ".tmp"
        fs.writeFileSync(tmp, JSON.stringify({ names: Object.fromEntries(map) }), "utf8")
        fs.renameSync(tmp, file)
      } catch { /* 名字只是缓存，写不进去不影响主流程；内存里的照常用 */ }
      return changed
    },
  }
}

/** 查不到的群多久之后才再问一次 */
export const CHAT_NAME_RETRY_MS = 5 * 60_000
/** 一次请求最多问几个群：daemon 逐个调飞书，一批太大会超过请求超时，已经问到的也一起丢 */
export const CHAT_NAME_CHUNK = 10

export interface ChatNameFetcherDeps {
  /**
   * 向 daemon 要一批聊天名（聊天键 → 名字，查不到的不在里面）。
   * 返回 null = 现在问不了（daemon 没起），不算失败也不冷却；抛错 = 这次请求失败，这批进入冷却。
   */
  request: (chatKeys: string[]) => Promise<Record<string, string> | null>
  /** 本次运行里查到的名字。重启后它是空的，所以每个群启动后都会重新问一次（群改了名能跟上） */
  cache: Map<string, string>
  /** 查到的同时记到盘上，重启后在重新问到之前先用它 */
  book?: ChatNameBook
  now?: () => number
  retryMs?: number
  chunkSize?: number
}

export function createChatNameFetcher(deps: ChatNameFetcherDeps): { fetch(chatKeys: readonly string[]): Promise<void> } {
  const failedAt = new Map<string, number>()
  const inFlight = new Set<string>()

  async function fetchNames(chatKeys: readonly string[]): Promise<void> {
    const now = deps.now ?? Date.now
    const retryMs = deps.retryMs ?? CHAT_NAME_RETRY_MS
    const size = Math.max(1, deps.chunkSize ?? CHAT_NAME_CHUNK)
    const todo = [...new Set(chatKeys)].filter(
      (id) => id && !deps.cache.has(id) && !inFlight.has(id) && now() - (failedAt.get(id) ?? -Infinity) > retryMs,
    )
    for (let i = 0; i < todo.length; i += size) {
      const chunk = todo.slice(i, i + size)
      for (const id of chunk) inFlight.add(id)
      try {
        const res = await deps.request(chunk)
        if (res === null) return
        const found: Record<string, string> = {}
        for (const id of chunk) {
          const name = res[id]
          if (name) {
            deps.cache.set(id, name)
            found[id] = name
            failedAt.delete(id)
          } else {
            failedAt.set(id, now())
          }
        }
        deps.book?.setMany(found)
      } catch {
        for (const id of chunk) failedAt.set(id, now())
      } finally {
        for (const id of chunk) inFlight.delete(id)
      }
    }
  }

  return { fetch: fetchNames }
}

// ── 对话文字里的路径：批量向主进程确认「能不能预览」（带缓存、合并请求）──────────────
//
// 一条回复里可能有十几个路径，每个路径渲染时各问一次主进程太浪费。这里把同一时刻的请求合并成一次批量调用，
// 并把结果缓存：确认能预览的一直有效；查不到的只缓存一小会儿（文件可能是 Agent 刚刚才写出来的，过一会儿再问就有了）。

import { PREVIEW_CHECK_MAX_PATHS } from "../../../shared/preview-types"

/** 批量检查：返回和输入一一对应的数组，能预览的是绝对路径，不能的是 null */
export type CheckPaths = (paths: string[]) => Promise<(string | null)[]>

export interface PathResolverOptions {
  /** 「查不到」的结果缓存多久（毫秒） */
  missTtlMs?: number
  now?: () => number
}

interface Entry {
  promise: Promise<string | null>
  settle: (path: string | null) => void
  /** 缓存到什么时候；还在查的、确认能预览的都是 Infinity */
  expires: number
}

export function createPathResolver(check: CheckPaths, options: PathResolverOptions = {}): (raw: string) => Promise<string | null> {
  const missTtl = options.missTtlMs ?? 5000
  const now = options.now ?? Date.now
  const cache = new Map<string, Entry>()
  let queue: string[] = []
  let scheduled = false

  const flush = async () => {
    scheduled = false
    const raws = queue
    queue = []
    for (let i = 0; i < raws.length; i += PREVIEW_CHECK_MAX_PATHS) {
      const part = raws.slice(i, i + PREVIEW_CHECK_MAX_PATHS)
      const entries = part.map((raw) => cache.get(raw)!)
      let result: (string | null)[] | undefined
      try {
        result = await check(part)
      } catch { /* 主进程没响应：这一批都当查不到，也不缓存，下次渲染还会再问 */ }
      entries.forEach((entry, j) => {
        if (!result) {
          cache.delete(part[j])
          entry.settle(null)
          return
        }
        const path = result[j] ?? null
        entry.expires = path === null ? now() + missTtl : Infinity
        entry.settle(path)
      })
    }
  }

  return (raw) => {
    const hit = cache.get(raw)
    if (hit && hit.expires > now()) return hit.promise
    let settle!: (path: string | null) => void
    const promise = new Promise<string | null>((resolve) => { settle = resolve })
    cache.set(raw, { promise, settle, expires: Infinity })
    queue.push(raw)
    if (!scheduled) {
      scheduled = true
      queueMicrotask(() => void flush())
    }
    return promise
  }
}

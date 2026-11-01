import { createHmac, randomBytes } from "node:crypto"
import { challengeMessage } from "./mobile-challenge.js"

/** 电脑端对手机挑战随机数的应答（见 mobile-challenge.ts）；手机端用同样的算法验算 */
export function computeChallengeProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(challengeMessage(nonce)).digest("hex")
}

// 路径包含判断挪到了 path-inside.ts（Skill 目录校验也要用），这里转出，原有的引用方不用改
export { isPathInside } from "./path-inside.js"

export interface FileTicketStore {
  /** 为已通过鉴权的文件路径签发下载票据 */
  issue(filePath: string): string
  /** 凭票据换回文件路径；不存在或已过期返回 null */
  resolve(ticket: string): string | null
}

/**
 * 文件下载票据：下载链接由浏览器 / 系统下载器直接打开，带不了 Authorization 头，
 * 所以用「先带令牌换票据，再凭票据下载」的方式，避免长期令牌出现在 URL（会进访问日志、历史记录和 Referer）。
 * 票据只对应一个文件，短时有效；有效期内允许重复使用，以兼容下载器的重试与断点续传。
 */
export function createFileTicketStore(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
): FileTicketStore {
  const ttlMs = options.ttlMs ?? 120_000
  const maxEntries = options.maxEntries ?? 200
  const now = options.now ?? Date.now
  const entries = new Map<string, { filePath: string; expiresAt: number }>()

  return {
    issue(filePath) {
      const t = now()
      for (const [key, entry] of entries) {
        if (entry.expiresAt <= t) entries.delete(key)
      }
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      const ticket = randomBytes(16).toString("hex")
      entries.set(ticket, { filePath, expiresAt: t + ttlMs })
      return ticket
    },
    resolve(ticket) {
      const entry = entries.get(ticket)
      if (!entry) return null
      if (entry.expiresAt <= now()) {
        entries.delete(ticket)
        return null
      }
      return entry.filePath
    },
  }
}

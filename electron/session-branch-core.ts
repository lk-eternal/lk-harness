// ── 会话切分支：「能不能切」的规则（不依赖 electron，可直接单测）─────────
// 分支属于工作目录，不属于会话：多个会话可以共用一个目录，所以切换对它们都生效。
// 因此切换前要确认这个目录里没有会话正在回复（Agent 做到一半换了代码会读写到错的版本），
// 并且同一个目录同一时间只允许一次切换。
// 真正执行 git 的在 git-branch.ts，会话怎么找到目录、哪些会话在回复由 session-branch.ts 接上。

import type { BranchListResult, BranchSwitchResult, BranchTarget } from "../src/shared/git-branch"
import { appChatSessionId, sameChatDir } from "../src/shared/app-chat-types"
import type { BranchStateResult, SwitchOutcome } from "./git-branch"

export type ResolvedDir = { ok: true; dir: string } | { ok: false; error: string }

export interface SessionBranchDeps {
  /** 会话的工作目录；项目会话、没选目录的临时会话、不是应用内会话的返回原因 */
  resolveDir(sessionKey: string): ResolvedDir
  /** 这个仓库里此刻有回合在跑的会话（会话键）；toplevel 是仓库根目录 */
  workingSessions(dir: string, toplevel: string): Promise<string[]>
  readState(dir: string): Promise<BranchStateResult>
  switchBranch(dir: string, target: BranchTarget): Promise<SwitchOutcome>
  /** 切换成功之后：清分支缓存、记日志、通知两端刷新 */
  switched(info: { sessionKey: string; dir: string; from: string; to: string }): void
}

export interface SessionBranchService {
  list(sessionKey: string): Promise<BranchListResult>
  switchTo(sessionKey: string, target: BranchTarget): Promise<BranchSwitchResult>
}

/** 为什么现在不能切：自己的会话在回复，还是别的会话在这个目录里工作 */
export function workingBlockedReason(sessionKey: string, working: readonly string[]): string | undefined {
  if (working.length === 0) return undefined
  const self = appChatSessionId(sessionKey)
  if (working.some((k) => appChatSessionId(k) === self)) return "这个会话正在回复，等它结束再切换分支"
  return `有 ${working.length} 个会话正在这个目录里工作，等它们结束再切换分支`
}

function dirKey(dir: string): string {
  return dir.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase()
}

export function createSessionBranchService(deps: SessionBranchDeps): SessionBranchService {
  /** 正在切换的目录：同一个目录同时只切一次（连点、两端同时点） */
  const switching = new Set<string>()

  return {
    async list(sessionKey) {
      const resolved = deps.resolveDir(sessionKey)
      if (!resolved.ok) return resolved
      const state = await deps.readState(resolved.dir)
      if (!state.ok) return state
      const working = await deps.workingSessions(resolved.dir, state.toplevel)
      const blocked = state.inProgress
        ?? workingBlockedReason(sessionKey, working)
        ?? (switching.has(dirKey(resolved.dir)) ? "正在切换分支，请稍候" : undefined)
      return {
        ok: true,
        current: state.current,
        detached: state.detached,
        branches: state.branches,
        dirty: state.dirty,
        ...(state.truncated ? { truncated: true } : {}),
        ...(blocked ? { blocked } : {}),
      }
    },

    async switchTo(sessionKey, target) {
      const resolved = deps.resolveDir(sessionKey)
      if (!resolved.ok) return resolved
      const key = dirKey(resolved.dir)
      if (switching.has(key)) return { ok: false, error: "正在切换分支，请稍候" }
      switching.add(key)
      try {
        const state = await deps.readState(resolved.dir)
        if (!state.ok) return state
        const reason = workingBlockedReason(sessionKey, await deps.workingSessions(resolved.dir, state.toplevel))
        if (reason) return { ok: false, error: reason }
        const r = await deps.switchBranch(resolved.dir, target)
        if (!r.ok) return r
        if (r.current !== state.current) deps.switched({ sessionKey, dir: resolved.dir, from: state.current, to: r.current })
        return { ok: true, current: r.current }
      } finally {
        switching.delete(key)
      }
    },
  }
}

/** 会话的目录在不在仓库里（含仓库根本身）：判断「这个会话在不在受影响的仓库里工作」 */
export function dirInsideRepo(sessionDir: string, toplevel: string): boolean {
  if (sameChatDir(sessionDir, toplevel)) return true
  const norm = (d: string) => d.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase()
  return norm(sessionDir).startsWith(`${norm(toplevel)}/`)
}

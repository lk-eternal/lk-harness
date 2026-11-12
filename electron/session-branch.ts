// ── 会话切分支：接到应用上（会话 → 目录，哪些会话在回复，通知两端刷新）──────
// 规则在 session-branch-core.ts，git 的执行在 git-branch.ts。桌面端走 IPC（app-chat.ts），
// 手机端走网关（mobile-server.ts），两端调的是同一份。

import { app } from "electron"
import * as fs from "node:fs"
import { getChannel } from "./config-store"
import { listAllAgentSessions } from "./agent-engine/control"
import { broadcastLog } from "./ui-logger"
import { readBranchState, switchBranch } from "./git-branch"
import { createSessionBranchService, dirInsideRepo, type ResolvedDir } from "./session-branch-core"
import { sameChatDir } from "../src/shared/app-chat-types"
import { channelIdFromSessionKey, workspaceDirFromSessionKey } from "../src/shared/channel-types"
import type { BranchListResult, BranchSwitchResult, BranchTarget } from "../src/shared/git-branch"
import { projectIdFromSessionKey } from "../src/shared/project-types"
import { getSessionRecord, initSessionOverridesStore } from "../src/shared/session-overrides-store"
import { clearGitBranchCache } from "../src/shared/session-label"
import { isTempChatWorkspace } from "../src/shared/temp-workspace"

const listeners = new Set<() => void>()

/** 分支被切换了（不管是哪一端切的）：桌面窗口和手机实时流都据此刷新 */
export function subscribeBranchChanged(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 读「用户给会话选的目录」：数据目录只初始化一次，之后逐个会话查（遍历所有会话时不用每个都初始化） */
function boundDirReader(): (sessionKey: string) => string | undefined {
  try {
    initSessionOverridesStore(app.getPath("userData"))
  } catch { return () => undefined }
  return (sessionKey) => {
    try { return getSessionRecord(sessionKey)?.boundDir } catch { return undefined }
  }
}

function resolveDir(sessionKey: string): ResolvedDir {
  const channelId = channelIdFromSessionKey(sessionKey)
  if (!channelId || getChannel(channelId)?.type !== "app") return { ok: false, error: "不是应用内对话的会话" }
  // 项目会话用的是项目自己的独立克隆，分支由项目流程管
  if (projectIdFromSessionKey(sessionKey)) return { ok: false, error: "项目会话的分支由项目管理，不能在这里切换" }
  const bound = boundDirReader()(sessionKey)
  const dir = bound || workspaceDirFromSessionKey(sessionKey)
  if (!dir || (!bound && isTempChatWorkspace(dir))) return { ok: false, error: "这个会话还没有选工作目录" }
  if (!fs.existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` }
  return { ok: true, dir }
}

/**
 * 会话此刻是不是在跑回合：看 worker 的阶段。
 * 不能用「会话进程在线」——回复完 Agent 仍挂在 poll 上，在线的会话大多没在干活，那样几乎永远切不了。
 */
async function isInTurn(sessionKey: string): Promise<boolean> {
  try {
    const [sdk, llm] = await Promise.all([import("./sdk-session-worker.js"), import("./llm-session-worker.js")])
    return sdk.getSdkWorkerPhase(sessionKey) === "processing" || llm.getLlmWorkerPhase(sessionKey) === "processing"
  } catch {
    return false
  }
}

async function workingSessions(dir: string, toplevel: string): Promise<string[]> {
  const keys: string[] = []
  const boundDirOf = boundDirReader()
  for (const s of listAllAgentSessions()) {
    // 项目会话在自己的克隆里工作，和这个仓库的工作区不是一处
    if (projectIdFromSessionKey(s.sessionKey)) continue
    const sessionDir = boundDirOf(s.sessionKey) || workspaceDirFromSessionKey(s.sessionKey) || s.workspaceDir
    if (!sessionDir) continue
    if (!sameChatDir(sessionDir, dir) && !dirInsideRepo(sessionDir, toplevel)) continue
    if (await isInTurn(s.sessionKey)) keys.push(s.sessionKey)
  }
  return keys
}

const service = createSessionBranchService({
  resolveDir,
  workingSessions,
  readState: readBranchState,
  switchBranch,
  switched({ sessionKey, dir, from, to }) {
    clearGitBranchCache()
    broadcastLog(`[Branch] ${dir}：${from} → ${to}（会话 ${sessionKey}）`)
    for (const fn of listeners) {
      try { fn() } catch { /* 某一端刷新失败不影响其它 */ }
    }
  },
})

export function listSessionBranches(sessionKey: string): Promise<BranchListResult> {
  return service.list(sessionKey)
}

export function switchSessionBranch(sessionKey: string, target: BranchTarget): Promise<BranchSwitchResult> {
  return service.switchTo(sessionKey, target)
}

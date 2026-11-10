import * as path from "node:path"
import { workspaceDirFromSessionKey } from "./channel-types.js"

/** 裸 temp_*、定时 task.id 等无 chatKey / 无 ::路径 的系统会话 */
export function isBareSystemSessionKey(sessionKey: string): boolean {
  const sk = sessionKey.trim()
  if (!sk) return false
  if (sk.startsWith("temp_")) return true
  return !sk.includes("|") && !sk.includes("::")
}

/** 与群聊 others 相同：AppData/workspaces/<safeSessionKey> */
export function isolatedSessionWorkspaceDir(userDataDir: string, sessionKey: string): string {
  const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")
  return path.join(userDataDir, "workspaces", safe)
}

export type ResolveSessionWorkspaceOpts = {
  userDataDir: string
  sessionKey: string
  /** 主用户 p2p 裸 chatKey 时回落通道主目录 */
  mainWorkspaceDir?: string
  /** 用户给会话选的工作目录（会话记录里的 boundDir），有就优先于会话键里的目录 */
  boundDir?: string
}

/** launch / reset / 展示共用的 Agent cwd（不含项目 worktree、不含显式 workingDirectory） */
export function resolveSessionWorkspaceDir(opts: ResolveSessionWorkspaceOpts): string | undefined {
  const { userDataDir, sessionKey, mainWorkspaceDir, boundDir } = opts
  const sk = sessionKey.trim()
  if (!sk) return undefined

  if (boundDir?.trim()) return path.normalize(boundDir.trim())

  const fromKey = workspaceDirFromSessionKey(sk)
  if (fromKey) return path.normalize(fromKey)

  if (isBareSystemSessionKey(sk)) {
    return isolatedSessionWorkspaceDir(userDataDir, sk)
  }

  if (mainWorkspaceDir?.trim()) {
    return path.normalize(mainWorkspaceDir.trim())
  }

  return isolatedSessionWorkspaceDir(userDataDir, sk)
}

import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeSessionKey } from "./channel-types.js";
import { TEMP_WORKSPACE_PREFIX } from "./temp-workspace.js";

/**
 * 与飞书 `/c new` 相同：独立 workspaces/temp_* 目录 + chatKey::path 会话键。
 * 目录名取毫秒时间戳，同一毫秒里连建两个（定时任务批量建专属会话）会撞同一个目录，撞了就顺延 1ms。
 */
export function createTempChatSession(
  userDataDir: string,
  chatId: string,
): { sessionKey: string; workspaceDir: string } {
  let stamp = Date.now();
  let workspaceDir = path.join(userDataDir, "workspaces", `${TEMP_WORKSPACE_PREFIX}${stamp}`);
  while (fs.existsSync(workspaceDir)) {
    stamp += 1;
    workspaceDir = path.join(userDataDir, "workspaces", `${TEMP_WORKSPACE_PREFIX}${stamp}`);
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sessionKey = normalizeSessionKey(`${chatId}::${workspaceDir}`) || `${chatId}::${workspaceDir}`;
  return { sessionKey, workspaceDir };
}

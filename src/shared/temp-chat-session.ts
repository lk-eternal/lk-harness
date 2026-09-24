import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeSessionKey } from "./channel-types.js";

/** 与飞书 `/c new` 相同：独立 workspaces/temp_* 目录 + chatKey::path 会话键 */
export function createTempChatSession(
  userDataDir: string,
  chatId: string,
): { sessionKey: string; workspaceDir: string } {
  const folderName = `temp_${Date.now()}`;
  const workspaceDir = path.join(userDataDir, "workspaces", folderName);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const sessionKey = normalizeSessionKey(`${chatId}::${workspaceDir}`) || `${chatId}::${workspaceDir}`;
  return { sessionKey, workspaceDir };
}

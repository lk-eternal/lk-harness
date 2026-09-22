import { chatIdFromSessionKey } from "./channel-types.js"
import {
  initSessionOverridesStore,
  resetSessionOverridesStoreForTests,
  patchSessionRecord,
  getSessionRecord,
} from "./session-overrides-store.js"

/** 会话级供应商（Agent 资源）覆盖：只影响当前会话，不碰通道默认 */

export function initSessionResourceStore(dir: string): void {
  initSessionOverridesStore(dir)
}

export function resetSessionResourceStoreForTests(): void {
  resetSessionOverridesStoreForTests()
}

function readStoredResourceOverride(sessionKey: string): string | undefined {
  return getSessionRecord(sessionKey)?.resourceId
}

export function setSessionResourceOverride(sessionKey: string, resourceId: string): void {
  patchSessionRecord(sessionKey, { resourceId })
}

export function getSessionResourceOverride(sessionKey: string): string | undefined {
  const direct = readStoredResourceOverride(sessionKey)
  if (direct) return direct
  const chat = chatIdFromSessionKey(sessionKey)
  if (chat && chat !== sessionKey) return readStoredResourceOverride(chat)
  return undefined
}

export function clearSessionResourceOverride(sessionKey: string): void {
  patchSessionRecord(sessionKey, { resourceId: undefined })
}

/** 会话有效资源：override > 通道默认 */
export function resolveResourceForSession(sessionKey: string, channelResourceId: string | undefined): string | undefined {
  return getSessionResourceOverride(sessionKey) ?? channelResourceId
}

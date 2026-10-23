import { modelSlug } from "./model-utils.js"
import { APP_CHANNEL_CHAT_ID, chatIdFromSessionKey, parseChatKey } from "./channel-types.js"
import {
  initSessionOverridesStore,
  resetSessionOverridesStoreForTests,
  patchSessionRecord,
  getSessionRecord,
  getRecentModelsFromStore,
  setRecentModelsInStore,
  getLastModelFromStore,
  setLastModelInStore,
  readOverridesSnapshot,
} from "./session-overrides-store.js"

export interface ModelRef {
  model: string
  modelParams?: string
  /** 所属供应商；缺省=老数据（未绑定） */
  resourceId?: string
}

export interface ModelEntry extends ModelRef {
  label?: string
  usedAt?: number
}

const DEFAULT_RECENT_CAP = 8

export function initSessionModelStore(dir: string): void {
  initSessionOverridesStore(dir)
}

export function resetSessionModelStoreForTests(): void {
  resetSessionOverridesStoreForTests()
}

/** 已知当前会话供应商时：无 resourceId 或与当前不一致的 override 不得生效（防 LLM 模型串到 SDK） */
export function overrideMatchesResource(ov: ModelRef, resourceId: string | undefined): boolean {
  const cur = resourceId?.trim()
  if (!cur) return true
  const bound = ov.resourceId?.trim()
  if (!bound) return false
  return bound === cur
}

export function modelEntryKey(e: ModelRef): string {
  return `${e.model}\0${e.modelParams ?? ""}\0${e.resourceId ?? ""}`
}

export function pendingKey(chatKey: string, workspaceDir: string): string {
  return `${chatKey}::${workspaceDir}`
}

/** sessionKey 形如 chatKey::workspace；无 :: 时整段当作 chatKey */
export function pendingKeyFromSession(sessionKey: string): string {
  const idx = sessionKey.indexOf("::")
  if (idx < 0) return sessionKey
  return sessionKey
}

function readStoredOverride(sessionKey: string): ModelRef | undefined {
  const e = getSessionRecord(sessionKey)
  if (!e?.model) return undefined
  return { model: e.model, modelParams: e.modelParams ?? "", ...(e.resourceId ? { resourceId: e.resourceId } : {}) }
}

function pickSessionOverride(sessionKey: string, resourceId: string | undefined): ModelRef | undefined {
  const direct = readStoredOverride(sessionKey)
  if (direct && overrideMatchesResource(direct, resourceId)) return direct
  const chat = chatIdFromSessionKey(sessionKey)
  if (chat && chat !== sessionKey) {
    const parent = readStoredOverride(chat)
    if (parent && overrideMatchesResource(parent, resourceId)) return parent
  }
  return undefined
}

export function setSessionOverride(sessionKey: string, ref: ModelRef): void {
  const old = getSessionRecord(sessionKey)
  const rid = ref.resourceId ?? old?.resourceId
  patchSessionRecord(sessionKey, {
    model: ref.model,
    modelParams: ref.modelParams ?? "",
    ...(rid ? { resourceId: rid } : {}),
  })
}

export function getSessionOverride(sessionKey: string, resourceId?: string): ModelRef | undefined {
  return pickSessionOverride(sessionKey, resourceId)
}

export function clearSessionOverride(sessionKey: string): void {
  patchSessionRecord(sessionKey, { model: undefined, modelParams: undefined })
}

/** 切供应商时一次落盘：resource + model（或清模型覆盖） */
export function applySessionProviderSwitch(
  sessionKey: string,
  opts: { resourceId: string | null; model?: ModelRef | null },
): void {
  const patch: Parameters<typeof patchSessionRecord>[1] = {}
  if (opts.resourceId === null) patch.resourceId = undefined
  else patch.resourceId = opts.resourceId
  if (opts.model === null) {
    patch.model = undefined
    patch.modelParams = undefined
  } else if (opts.model) {
    patch.model = opts.model.model
    patch.modelParams = opts.model.modelParams ?? ""
    patch.resourceId = opts.model.resourceId ?? opts.resourceId ?? undefined
  }
  patchSessionRecord(sessionKey, patch)
}

/** 通道保存新模型时清掉该通道下所有会话 override，避免仍用旧 /m 或历史模型 */
export function clearSessionOverridesForChannel(channelId: string): void {
  const s = readOverridesSnapshot()
  const prefix = `${channelId}|`
  for (const key of Object.keys(s.sessions)) {
    if (key.startsWith(prefix) && s.sessions[key]?.model) {
      patchSessionRecord(key, { model: undefined, modelParams: undefined })
    }
  }
}

/** 解析会话有效模型：session override > fallback */
export function resolveModelForSession(sessionKey: string, fallback: ModelRef): ModelRef {
  const resourceId = fallback.resourceId
  const ov = pickSessionOverride(sessionKey, resourceId)
  if (ov) return ov

  return {
    model: fallback.model,
    modelParams: fallback.modelParams ?? "",
    ...(fallback.resourceId ? { resourceId: fallback.resourceId } : {}),
  }
}

export function getRecentModels(): ModelEntry[] {
  return getRecentModelsFromStore()
}

export function pushRecentModel(ref: ModelRef, cap = DEFAULT_RECENT_CAP): void {
  const recent = getRecentModelsFromStore()
  const key = modelEntryKey(ref)
  const next = recent.filter((r) => modelEntryKey(r) !== key)
  next.unshift({
    model: ref.model,
    modelParams: ref.modelParams ?? "",
    ...(ref.resourceId ? { resourceId: ref.resourceId } : {}),
    usedAt: Date.now(),
  })
  const cleaned = ref.resourceId
    ? next.filter((r, i) => i === 0 || !(r.model === ref.model && (r.modelParams ?? "") === (ref.modelParams ?? "") && !r.resourceId))
    : next
  setRecentModelsInStore(cleaned.slice(0, Math.max(1, cap)))
}

/**
 * 会话属于哪个应用通道的「我自己」；不是的返回 undefined。
 * 飞书里的其他人、定时任务、没有通道前缀的裸会话都不算：它们用什么模型，不该决定我下一个新会话用什么。
 */
function appMainChannelOf(sessionKey: string): string | undefined {
  const { channelId, chatId } = parseChatKey(chatIdFromSessionKey(sessionKey))
  return channelId && chatId === APP_CHANNEL_CHAT_ID ? channelId : undefined
}

/**
 * 一个会话用上了某个模型（Agent 启动、或手动换模）：记入「最近使用」，
 * 并且若是应用通道里「我自己」的会话，再记成该通道上一次用的模型，供新会话当默认。
 */
export function recordModelUse(sessionKey: string, ref: ModelRef): void {
  pushRecentModel(ref)
  const channelId = appMainChannelOf(sessionKey)
  if (!channelId || !ref.model?.trim()) return
  setLastModelInStore(channelId, {
    model: ref.model,
    modelParams: ref.modelParams ?? "",
    ...(ref.resourceId ? { resourceId: ref.resourceId } : {}),
    usedAt: Date.now(),
  })
}

/**
 * 新会话的默认模型 = 该通道里我上一次用的模型，写成这个新会话自己的 override。
 * - 只在创建时写一次，不是每次解析都取「最近」：否则已有会话会在别处换模后跟着变，界面显示和实际启动也可能对不上；
 * - resourceId 必须是新会话启动时实际生效的供应商：override 与当前供应商不一致就不会生效（防 LLM 模型串到 SDK），
 *   所以上次用的模型属于别的供应商（换过供应商）时不写，退回通道默认模型；
 * - 会话已有自己的模型就不动。
 * 返回写入的模型，没写返回 undefined。
 */
export function seedNewSessionModel(sessionKey: string, channelId: string, resourceId: string): ModelRef | undefined {
  const rid = resourceId.trim()
  if (!rid) return undefined
  if (getSessionRecord(sessionKey)?.model) return undefined
  const last = getLastModelFromStore(channelId)
  if (!last || last.resourceId !== rid) return undefined
  const ref: ModelRef = { model: last.model, modelParams: last.modelParams ?? "", resourceId: rid }
  setSessionOverride(sessionKey, ref)
  return ref
}

export function removeRecentModel(ref: ModelRef): void {
  const recent = getRecentModelsFromStore()
  const key = modelEntryKey(ref)
  const next = recent.filter((r) => modelEntryKey(r) !== key)
  if (next.length === recent.length) return
  setRecentModelsInStore(next)
}

/** 收藏置顶 + 最近补充，按 model+params+resourceId 去重，最多 limit 条 */
export function listQuickModels(favorites: ModelEntry[], limit = 6): ModelEntry[] {
  const out: ModelEntry[] = []
  const seen = new Set<string>()
  const boundModels = new Set<string>()
  for (const f of favorites) {
    if (f.model && (f as ModelRef).resourceId) boundModels.add(`${f.model}\0${f.modelParams ?? ""}`)
  }
  for (const r of getRecentModels()) {
    if (r.resourceId) boundModels.add(`${r.model}\0${r.modelParams ?? ""}`)
  }
  const add = (e: ModelEntry) => {
    if (!e.model || out.length >= limit) return
    const k = modelEntryKey(e)
    if (seen.has(k)) return
    const ref = e as ModelRef
    if (!ref.resourceId && boundModels.has(`${e.model}\0${e.modelParams ?? ""}`)) return
    seen.add(k)
    out.push({
      model: e.model,
      modelParams: e.modelParams ?? "",
      label: e.label || modelSlug(e.model, e.modelParams) || e.model,
      ...(ref.resourceId ? { resourceId: ref.resourceId } : {}),
    } as ModelEntry)
  }
  for (const f of favorites) add(f)
  for (const r of getRecentModels()) add(r)
  return out
}

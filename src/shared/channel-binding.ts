/** 主用户绑定落盘保护（纯函数，无 Electron 依赖，可单测） */

export interface BoundChannel {
  id: string
  mainUserOpenId?: string
}

/** 落盘保护：旧快照整体保存时不得洗掉已绑定的 openId（只补不删；解绑清开关，不清号） */
export function preserveChannelBindings<T extends BoundChannel>(
  incoming: T[] | undefined,
  stored: BoundChannel[] | undefined,
): T[] | undefined {
  if (!incoming) return incoming
  const byId = new Map((stored ?? []).map((c) => [c.id, c.mainUserOpenId]))
  let changed = false
  const out = incoming.map((c) => {
    const kept = byId.get(c.id)?.trim()
    if (kept && !c.mainUserOpenId?.trim()) {
      changed = true
      return { ...c, mainUserOpenId: byId.get(c.id) }
    }
    return c
  })
  return changed ? out : incoming
}

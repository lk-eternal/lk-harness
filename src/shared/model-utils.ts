/** 与设置页 listSdkModels 同一�?slug：thinking=true �?-thinking；context=1m �?-1m */
export function modelSlugFromParams(id: string, params: { id: string; value: string }[]): string {
  return id + params
    .filter((p) => p.value !== "false")
    .map((p) => (p.value === "true" ? `-${p.id}` : `-${p.value}`))
    .join("")
}

/** 模型展示名：id + variant 参数 JSON�? 设置页选项文案�?*/
export function modelSlug(id?: string, paramsJson?: string): string {
  if (!id) return ""
  if (!paramsJson?.trim()) return id
  try {
    return modelSlugFromParams(id, JSON.parse(paramsJson) as { id: string; value: string }[])
  } catch {
    return id
  }
}

export function modelLabelKey(model: string, params?: string): string {
  return `${model}\0${params ?? ""}`
}

const labelCache = new Map<string, string>()

/** 缓存 listSdkModels �?label，供 /s /c /m 与设置页对齐 */
export function rememberModelLabel(model: string, params: string | undefined, label: string): void {
  const t = label?.trim()
  if (!model || !t) return
  labelCache.set(modelLabelKey(model, params), t)
}

/** 优先 listSdkModels 缓存 �?调用�?label �?modelSlug */
export function resolveModelLabel(
  model?: string,
  params?: string,
  fallbackLabel?: string,
): string {
  if (!model?.trim()) return ""
  const cached = labelCache.get(modelLabelKey(model, params))
  if (cached) return cached
  const fb = fallbackLabel?.trim()
  if (fb) return fb
  return modelSlug(model, params) || model
}

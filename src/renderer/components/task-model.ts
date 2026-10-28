import type { ModelChoice } from "./chat/model-picker-logic"

/** 定时任务里和「跑在哪、用什么模型」有关的字段 */
export interface TaskModelFields {
  channelId?: string
  model?: string
  modelParams?: string
}

interface ChannelLike { id: string; agentResourceId?: string }
interface ResourceLike { id: string }

/**
 * 任务实际用哪一家供应商：所选通道的主用户供应商；没选通道（或通道已删）时和原来的表单一样取第一个通道。
 * 通道没配供应商、或配的那一家已经不存在时返回 undefined，此时选择器置灰，不去猜一个。
 */
export function resolveTaskResourceId(
  channels: ChannelLike[],
  resources: ResourceLike[],
  channelId: string | undefined,
): string | undefined {
  const channel = channels.find((c) => c.id === channelId) ?? channels[0]
  const id = channel?.agentResourceId
  return id && resources.some((r) => r.id === id) ? id : undefined
}

/** 选了模型：「跟随通道主模型」（模型为空）把 model / modelParams 一起清掉 */
export function applyTaskModel<T extends TaskModelFields>(task: T, choice: Pick<ModelChoice, "model" | "modelParams">): T {
  const model = choice.model.trim()
  if (!model) return { ...task, model: undefined, modelParams: undefined }
  return { ...task, model: choice.model, modelParams: choice.modelParams || undefined }
}

/**
 * 换通道。模型名是跟着供应商走的（选择器只列所选通道那一家的模型），换到另一家供应商后原来的模型
 * 在新供应商上多半不存在，留着会让任务跑起来才报错，所以改回「跟随通道主模型」；供应商没变就原样保留。
 */
export function applyTaskChannel<T extends TaskModelFields>(
  task: T,
  channelId: string | undefined,
  channels: ChannelLike[],
  resources: ResourceLike[],
): T {
  const before = resolveTaskResourceId(channels, resources, task.channelId)
  const after = resolveTaskResourceId(channels, resources, channelId)
  const next = { ...task, channelId }
  return before === after ? next : { ...next, model: undefined, modelParams: undefined }
}

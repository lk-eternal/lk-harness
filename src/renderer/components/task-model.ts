import type { ModelChoice } from "./chat/model-picker-logic"

/** 定时任务里和「跑在哪、用什么模型」有关的字段 */
export interface TaskModelFields {
  channelId?: string
  /** 任务自己选的供应商；空 = 跟随通道的供应商 */
  resourceId?: string
  model?: string
  modelParams?: string
}

interface ChannelLike { id: string; agentResourceId?: string }
interface ResourceLike { id: string }

/**
 * 通道的供应商：所选通道的主用户供应商；没选通道（或通道已删）时和原来的表单一样取第一个通道。
 * 任务没有自己选供应商时就跟随它（选择器里「跟随通道」那一项列的是它家的模型）。
 * 通道没配供应商、或配的那一家已经不存在时返回 undefined，不去猜一个。
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

/**
 * 选了供应商 / 模型：
 * - 「跟随通道主模型」（模型为空）：供应商、模型、参数一起清掉，整个跟随通道；
 * - 选了具体模型：模型、参数记下。供应商选的是「跟随通道」（空串）就清掉任务自己的供应商，
 *   选的是某一家就记下，任务从此固定用这一家（哪怕它恰好就是通道现在的那一家，通道以后换了供应商它也不跟着变）。
 */
export function applyTaskModel<T extends TaskModelFields>(
  task: T,
  choice: Pick<ModelChoice, "model" | "modelParams" | "resourceId">,
): T {
  const model = choice.model.trim()
  if (!model) return { ...task, resourceId: undefined, model: undefined, modelParams: undefined }
  return {
    ...task,
    resourceId: choice.resourceId.trim() || undefined,
    model: choice.model,
    modelParams: choice.modelParams || undefined,
  }
}

/**
 * 换通道。
 * - 任务自己选了供应商：模型是它家的，和通道无关，原样保留；
 * - 跟随通道的供应商：模型名是跟着供应商走的，换到另一家供应商后原来的模型在新供应商上多半不存在，
 *   留着会让任务跑起来才报错，所以改回「跟随通道主模型」；供应商没变就原样保留。
 */
export function applyTaskChannel<T extends TaskModelFields>(
  task: T,
  channelId: string | undefined,
  channels: ChannelLike[],
  resources: ResourceLike[],
): T {
  const next = { ...task, channelId }
  if (task.resourceId?.trim()) return next
  const before = resolveTaskResourceId(channels, resources, task.channelId)
  const after = resolveTaskResourceId(channels, resources, channelId)
  return before === after ? next : { ...next, model: undefined, modelParams: undefined }
}

/** 任务自己选的供应商已经不在配置里了（被删了）：运行时会因找不到资源而失败，界面要提醒重新选 */
export function taskResourceMissing(task: Pick<TaskModelFields, "resourceId">, resources: ResourceLike[]): boolean {
  const id = task.resourceId?.trim()
  return !!id && !resources.some((r) => r.id === id)
}

import { resolveTaskLaunchModel, type ChannelModelFields, type LaunchModelInput } from "./launch-model.js"
import { resolveTaskChannelId, type ScheduledTask } from "./scheduled-task.js"

/** 工作台会话行上显示的模型：模型、参数、供应商；都取不到时是空对象（界面显示「选择模型」） */
export interface TabModel {
  model?: string
  modelParams?: string
  resourceId?: string
}

/**
 * 定时任务那一行显示的模型。独立任务的会话键是裸任务 id，凭键认不出所属通道，
 * 所以通道按任务绑定的（没绑取第一个启用的）找，模型按任务自己配的、没配跟随通道主模型，
 * 和任务真实拉起（队列唤醒走 resolveTaskChannelId + launchAgent）是同一套规则。
 */
export function taskTabModel(input: {
  sessionKey: string
  task: Pick<ScheduledTask, "channelId" | "model" | "modelParams" | "resourceId">
  channels: readonly (ChannelModelFields & { id: string; enabled?: boolean })[]
  resolveResource: LaunchModelInput["resolveResource"]
}): TabModel {
  const channelId = resolveTaskChannelId(input.task, input.channels)
  const eff = resolveTaskLaunchModel({
    sessionKey: input.sessionKey,
    task: input.task,
    channel: input.channels.find((c) => c.id === channelId),
    resolveResource: input.resolveResource,
  })
  if (!eff.model) return {}
  return {
    model: eff.model,
    modelParams: eff.modelParams,
    ...(eff.resolvedResourceId ? { resourceId: eff.resolvedResourceId } : {}),
  }
}

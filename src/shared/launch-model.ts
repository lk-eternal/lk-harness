import { resolveChannelAudience, resolveChannelResourceId, type ChannelAudience, type MessageChannel } from "./channel-types.js"
import { getSessionOverride, resolveModelForSession } from "./session-model-store.js"
import { resolveResourceForSession } from "./session-resource-store.js"

/** 通道里和「用哪个供应商、哪个模型」有关的字段 */
export type ChannelModelFields = Pick<
  MessageChannel,
  "agentResourceId" | "othersAgentResourceId" | "model" | "modelParams" | "othersModel" | "othersModelParams"
>

/** 通道里和「这个会话是主用户的还是其他人的」有关的字段 */
export type ChannelAudienceFields = Pick<MessageChannel, "mainUserEnabled" | "mainUserChatId">

/** 通道默认模型的取法：primary = 主用户（以及任务/项目/临时等系统会话）；others = 其他人与群聊 */
export type ModelScenario = "primary" | "others"

/** 通道默认模型；others 留空则跟随主模型 */
export function resolveChannelDefaultModel(
  channel: Pick<MessageChannel, "model" | "modelParams" | "othersModel" | "othersModelParams"> | undefined,
  scenario: ModelScenario,
): { model: string; modelParams: string } {
  if (!channel) return { model: "", modelParams: "" }
  if (scenario === "others" && channel.othersModel?.trim()) {
    return { model: channel.othersModel, modelParams: channel.othersModelParams ?? "" }
  }
  return { model: channel.model ?? "", modelParams: channel.modelParams ?? "" }
}

/** 通道里「其他人」没有单独配置时实际会用的供应商和模型（留空的跟随主用户 / 主模型） */
export interface OthersDefault {
  resourceId: string
  model: string
  modelParams: string
}

export function othersDefaultOf(channel: ChannelModelFields): OthersDefault {
  const { model, modelParams } = resolveChannelDefaultModel(channel, "others")
  return {
    resourceId: resolveChannelResourceId(channel, "others").trim(),
    model: model.trim(),
    modelParams: modelParams.trim(),
  }
}

/**
 * 通道配置改动后，其他人的默认供应商 / 模型有没有变。
 * 比的是「实际生效的」：其他人留空时跟随主用户，所以改主用户的模型也算（只要其他人没单独配）；
 * 其他人单独配了的，改主用户的不算。
 */
export function othersDefaultChanged(before: ChannelModelFields, after: ChannelModelFields): boolean {
  const a = othersDefaultOf(before)
  const b = othersDefaultOf(after)
  return a.resourceId !== b.resourceId || a.model !== b.model || a.modelParams !== b.modelParams
}

export interface LaunchModelInput {
  sessionKey: string
  channel: ChannelModelFields | undefined
  /** 会话人群：main 用主模型，others 用「其他人」那一套（留空跟随主） */
  audience: ChannelAudience
  /** 显式指定（定时任务 / 工作流节点），优先级最高；model 为空白视为没指定 */
  explicit?: { model: string; modelParams?: string }
  /**
   * 把供应商 id 解析成实际生效的 Agent 资源。找不到、或没配置时也要返回一个带 id 的对象
   * （主进程传 getAgentResource：没配置时回落到默认资源 / 「unset」）。放进参数是因为资源列表在主进程的配置里
   */
  resolveResource: (resourceId: string | undefined) => { id: string }
}

export interface LaunchModel {
  /** 按人群取的通道默认供应商 id（可能为空） */
  channelResourceId: string
  /** 会话级覆盖 + 通道默认之后的供应商 id（可能为空，此时用默认资源） */
  resourceId: string
  /** resolveResource 实际解析出的资源 id；与 resourceId 不同说明配置里找不到那个资源 */
  resolvedResourceId: string
  /** 供应商是会话自己改成了和通道默认不同的，还是跟着通道（会话里存的供应商恰好等于通道默认，算跟着通道） */
  resourceSource: "session" | "channel"
  model: string
  modelParams: string
  /** 模型来自：显式指定 / 会话自己存的（/m、会话页、工作台选的） / 通道默认 */
  modelSource: "explicit" | "session" | "channel"
}

/** 会话存储没初始化或读不出来时，沿用通道的值（原来 launchAgent 就是这么处理的），不让它拦住拉起 */
function orElse<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * 一个会话下次拉起时实际会用的供应商和模型。拉起 Agent（launchAgent）和会话管理页共用这一份，
 * 页面上显示的才会和真实拉起的一致。
 *
 * 规则（照搬原来 launchAgent 里内联的写法）：
 * - 供应商：会话级覆盖（会话自己存的，没有再看它所属聊天存的）> 通道按人群取的默认；
 * - 模型：显式指定 > 会话存的模型 > 通道默认模型（others 留空跟随主）；
 * - 会话存的模型必须和最终供应商匹配才生效：没有 resourceId 的老数据、或属于别的供应商的，一律不生效，
 *   免得把大模型供应商的模型名交给 Cursor SDK。
 *
 * 会话存储（session-overrides-store）要由调用方先初始化。
 */
export function resolveLaunchModel(input: LaunchModelInput): LaunchModel {
  const { sessionKey, channel, audience, explicit, resolveResource } = input

  const channelResourceId = resolveChannelResourceId(channel, audience)
  const resourceId = orElse(() => resolveResourceForSession(sessionKey, channelResourceId), undefined) ?? channelResourceId
  const resourceSource: LaunchModel["resourceSource"] = resourceId !== channelResourceId ? "session" : "channel"
  const resolvedResourceId = resolveResource(resourceId).id

  const explicitModel = explicit?.model?.trim()
  if (explicitModel) {
    return {
      channelResourceId,
      resourceId,
      resolvedResourceId,
      resourceSource,
      model: explicitModel,
      modelParams: explicit?.modelParams ?? "",
      modelSource: "explicit",
    }
  }

  const fallback = resolveChannelDefaultModel(channel, audience === "main" ? "primary" : "others")
  const eff = orElse(
    () => resolveModelForSession(sessionKey, { ...fallback, resourceId: resolvedResourceId }),
    { model: fallback.model, modelParams: fallback.modelParams },
  )
  const fromSession = orElse(() => !!getSessionOverride(sessionKey, resolvedResourceId), false)
  return {
    channelResourceId,
    resourceId,
    resolvedResourceId,
    resourceSource,
    model: eff.model,
    modelParams: eff.modelParams ?? "",
    modelSource: fromSession ? "session" : "channel",
  }
}

/**
 * 一个会话当前用的供应商 id：会话自己存的优先，否则是所属通道按人群取的默认（其他人留空跟随主用户）。
 *
 * 界面切换模型时，要拿它判断「是不是换了供应商」、并把模型覆盖记在正确的供应商名下。
 * 以前这里直接取通道的主供应商，给配了独立「其他人供应商」的通道里的别人的会话换模型时，
 * 当前供应商算错：同供应商换模型被当成换供应商，或覆盖记在了主供应商名下而不生效。
 *
 * 只能凭会话键判断人群（这里拿不到聊天类型）：主用户私聊、应用内对话、系统会话（临时/项目）归主用户，其余归其他人。
 * 定时任务的会话键是一串 id，凭键看不出来，调用方知道的话要把 chatType 传 "task"。
 */
export function resolveSessionResourceId(input: {
  sessionKey: string
  channel: (Pick<ChannelModelFields, "agentResourceId" | "othersAgentResourceId"> & Partial<ChannelAudienceFields>) | undefined
  chatType?: string
}): string {
  const { sessionKey, channel, chatType } = input
  const audience = resolveChannelAudience({
    mainUserEnabled: channel?.mainUserEnabled,
    mainUserChatId: channel?.mainUserChatId,
    sessionKey,
    chatType,
  })
  const channelResourceId = resolveChannelResourceId(channel, audience)
  return orElse(() => resolveResourceForSession(sessionKey, channelResourceId), undefined) ?? channelResourceId
}

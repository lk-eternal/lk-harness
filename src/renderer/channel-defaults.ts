import { APP_CHANNEL_CHAT_ID, type ChannelType } from "../shared/channel-types"

function newLocalChannelId(): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(16).padStart(2, "0")).join("")
  return `ch_${hex}`
}

export function emptyChannel(type: ChannelType, defaultName: string): ChannelConfig {
  return {
    id: newLocalChannelId(),
    name: defaultName,
    enabled: true,
    type,
    agentResourceId: "",
    othersAgentResourceId: "",
    model: "auto",
    modelParams: "",
    othersModel: "",
    othersModelParams: "",
    // 应用内对话固定绑定本机主用户，无需扫码/绑定流程
    mainUserEnabled: type === "app",
    mainUserChatId: type === "app" ? APP_CHANNEL_CHAT_ID : "",
    allowOthers: false,
    digitalIdentity: "",
    workspaceDir: "",
    keepSessionMain: true,
    persistentPollMain: true,
    showThinkingMain: true,
    streamKeepPerKindMain: 5,
    hideThinkingOnFinishMain: true,
    keepSessionOthers: true,
    persistentPollOthers: false,
    showThinkingOthers: false,
    streamKeepPerKindOthers: 5,
    hideThinkingOnFinishOthers: true,
  }
}

export const REQUIRED_FEISHU_SCOPES: { scope: string; desc: string }[] = [
  { scope: "im:message", desc: "发送消息（create / reply）" },
  { scope: "im:message.p2p_msg:readonly", desc: "接收私聊消息" },
  { scope: "im:message.group_at_msg:readonly", desc: "接收群聊 @消息" },
  { scope: "im:message.group_at_msg.include_bot:readonly", desc: "接收其他机器人 @本机器人的群消息（AI 间协作）" },
  { scope: "im:resource", desc: "上传/下载图片与文件" },
  { scope: "im:chat:read", desc: "获取群聊名称" },
  { scope: "im:chat:create", desc: "创建项目独立群" },
  { scope: "contact:contact.base:readonly", desc: "获取通讯录基本信息（需同时配置通讯录数据范围）" },
  { scope: "contact:user.base:readonly", desc: "获取用户基本信息（姓名/昵称，私聊会话显示）" },
  { scope: "cardkit:card:write", desc: "创建与更新 CardKit 流式卡片（Agent SDK 进度卡）" },
]

export const FEISHU_SCOPES_JSON = JSON.stringify(
  { scopes: { tenant: REQUIRED_FEISHU_SCOPES.map((p) => p.scope), user: [] } },
  null,
  2,
)

export const FEISHU_EVENT_SUBSCRIPTIONS = [
  { event: "im.message.receive_v1", desc: "接收消息 v2.0" },
  { event: "im.message.recalled_v1", desc: "撤回消息 v2.0 · 建议订阅，否则撤回消息后 Agent 不会停" },
]

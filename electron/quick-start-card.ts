import { reportCommandResult } from "./command-handler"
import { makeChatKey } from "../src/shared/channel-types.js"
import { buildWelcomeCard } from "../src/shared/quick-start.js"

/**
 * 主用户绑定成功后，给他的私聊发一张「快速上手」卡（飞书是按钮卡，微信自动降级成「发送：指令」列表）。
 * 走 daemon 的 /cmd/result 直发到私聊；发不出去（daemon 刚好没了、机器人被拉黑等）只记日志，不影响绑定本身。
 *
 * chatId 是 daemon 回报的原始 chat_id（不带通道前缀）；已经带前缀的原样用。
 */
export async function sendWelcomeCard(port: number, channelId: string, chatId: string): Promise<void> {
  const chatKey = chatId.startsWith(`${channelId}|`) ? chatId : makeChatKey(channelId, chatId)
  const card = buildWelcomeCard()
  await reportCommandResult(port, "", true, card.text, chatKey, card.buttons, { cardTitle: card.title })
}

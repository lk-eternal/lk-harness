/**
 * Agent 最近一次「有动静」的时间：会话 worker 每次开始或结束一个回合都记一笔。
 *
 * 给「空闲时自动重启安装」判断用：只看此刻有没有在跑回合不够，
 * 手机或飞书上连着聊的时候，回合之间会有几秒到几十秒的空档，不能在这种空档里把应用关掉。
 * 没有任何依赖，worker 里直接引。
 */

let lastActivityAt = Date.now()

/** 记一笔：Agent 刚开始或刚结束一个回合 */
export function noteAgentActivity(now: number = Date.now()): void {
  lastActivityAt = now
}

/** 距离上一次有动静过了多少毫秒；应用刚启动那一刻也算一笔，所以刚启动的几分钟内总是「不安静」 */
export function agentQuietMs(now: number = Date.now()): number {
  return Math.max(0, now - lastActivityAt)
}

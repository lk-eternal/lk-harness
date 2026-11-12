/**
 * 通道列表被别处改了的通知。
 * 设置页的通道面板在页面隐藏时也一直挂着，手里的列表是读进来那一刻的快照；
 * 对话页自动建了应用内通道之后不通知它，它之后一次保存就会拿旧列表把新通道覆盖掉。
 */
const CHANNELS_CHANGED = "lkh:channels-changed"

export function notifyChannelsChanged(): void {
  window.dispatchEvent(new Event(CHANNELS_CHANGED))
}

export function onChannelsChanged(cb: () => void): () => void {
  window.addEventListener(CHANNELS_CHANGED, cb)
  return () => window.removeEventListener(CHANNELS_CHANGED, cb)
}

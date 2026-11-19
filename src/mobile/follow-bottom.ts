/**
 * 每次滚动之后，列表要不要继续「跟着新内容滚到底」。
 *
 * 往上滚的时候不会重新打开：点顶部浮条回到某条提问时，平滑滚动的头几十 px 还在离底部 72px 以内，
 * 如果这时按位置重新打开，流式输出的下一次更新就会把列表拽回底部。
 * 已经在跟着的时候，往上滚但还在 72px 内（键盘收起、内容回弹这类自动调整）保持跟着。
 */
export function followBottomAfterScroll(following: boolean, movedUp: boolean, nearBottom: boolean): boolean {
  return nearBottom && (following || !movedUp)
}

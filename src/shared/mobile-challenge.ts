/**
 * 令牌挑战应答：手机在把令牌发给一个明文 http 地址之前，先确认对面是持有同一令牌的电脑端。
 * 换了个 Wi-Fi 后，保存的局域网地址可能落在陌生设备上；直接带着令牌去探测，等于把令牌送给对方。
 * 做法：手机发一个随机数，电脑用令牌对它做 HMAC-SHA256 后回传，手机本地验算；令牌本身不上线。
 * 本文件只放两端共用的格式；电脑端的应答在 mobile-access.ts，手机端的验算在 src/mobile/api.ts。
 */

/** 手机端生成 16 字节随机数的十六进制串；电脑端据此拒绝格式不对的请求 */
export const MOBILE_NONCE_PATTERN = /^[0-9a-f]{16,64}$/

/** 带域前缀：这个应答只能用来证明「我是 LK Harness 电脑端」，换不到别的用途的签名 */
export function challengeMessage(nonce: string): string {
  return `lk-harness-mobile-challenge\n${nonce}`
}

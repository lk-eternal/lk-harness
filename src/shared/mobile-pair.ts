// 手机端配对内容的唯一契约：桌面端生成（electron/mobile-server.ts），手机端解析（src/mobile/api.ts）。

export interface MobilePairPayload {
  v: 1
  /** 电脑名称 */
  name: string
  /** 鉴权 Token */
  token: string
  /** 公网地址，未配置时为空串 */
  pub: string
  /** 局域网地址，未检测到时为空串 */
  lan: string
}

export function buildPairPayload(input: {
  name: string
  token: string
  publicUrl: string
  lanUrls: string[]
}): MobilePairPayload {
  return {
    v: 1,
    name: input.name,
    token: input.token,
    pub: input.publicUrl,
    lan: input.lanUrls[0] ?? "",
  }
}

export function encodePairPayload(payload: MobilePairPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("")
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

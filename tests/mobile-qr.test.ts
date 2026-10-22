import QRCode from "qrcode"
import { describe, expect, it } from "vitest"
import { parsePairInput } from "../src/mobile/api"
import { decodeQrFrame } from "../src/mobile/qr-decode"
import { buildPairPayload, encodePairPayload } from "../src/shared/mobile-pair"

/** 把文本渲染成 RGBA 像素帧（白底黑块，四周留 4 模块静区），等价于屏幕上显示的二维码截图 */
function renderQrFrame(text: string, scale: number, level: "L" | "M") {
  const qr = QRCode.create(text, { errorCorrectionLevel: level })
  const size = qr.modules.size
  const margin = 4
  const side = (size + margin * 2) * scale
  const data = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!qr.modules.get(row, col)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (margin + col) * scale + dx
          const y = (margin + row) * scale + dy
          const i = (y * side + x) * 4
          data[i] = 0
          data[i + 1] = 0
          data[i + 2] = 0
        }
      }
    }
  }
  return { data, width: side, height: side }
}

describe("scan desktop pair QR", () => {
  const token = "aefb32d65b90befe59480d48b6e8236b51ce4d3c4f57b1f4"
  const payload = buildPairPayload({
    name: "DESKTOP-PC",
    token,
    publicUrl: "https://example.com/m",
    lanUrls: ["http://192.168.1.100:19529"],
  })
  const pairUrl = `https://example.com/m/?pair=${encodePairPayload(payload)}`

  it("decodes a dual-address pair link back to the same config", () => {
    const frame = renderQrFrame(pairUrl, 4, "L")
    const text = decodeQrFrame(frame)
    expect(text).toBe(pairUrl)
    expect(parsePairInput(text ?? "")).toMatchObject({
      pubUrl: "https://example.com/m",
      lanUrl: "http://192.168.1.100:19529",
      token,
      hostName: "DESKTOP-PC",
    })
  })

  it("returns null for a frame without a QR code", () => {
    const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(255), width: 200, height: 200 }
    expect(decodeQrFrame(blank)).toBeNull()
  })
})

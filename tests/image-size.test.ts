/**
 * 读图片宽高：用手搓的最小文件头覆盖 PNG / JPEG / GIF / WebP 三种编码，
 * 再用仓库里的真实图片和不存在的文件验证 readImageFileSize。
 */
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parseImageSize, readImageFileSize } from "../src/shared/image-size.js"

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.writeUInt32BE(13, 8)
  b.write("IHDR", 12, "ascii")
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  return b
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13)
  b.write("GIF89a", 0, "ascii")
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}

/** SOI + 一段无关的 APP1 + SOF0：帧头前面有别的段，要被跳过 */
function jpeg(width: number, height: number): Buffer {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x10]), Buffer.alloc(14)])
  const sof = Buffer.alloc(19)
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08], 0)
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof])
}

function webpHeader(fourcc: string): Buffer {
  const b = Buffer.alloc(30)
  b.write("RIFF", 0, "ascii")
  b.write("WEBP", 8, "ascii")
  b.write(fourcc, 12, "ascii")
  return b
}

function webpLossy(width: number, height: number): Buffer {
  const b = webpHeader("VP8 ")
  b.set([0x9d, 0x01, 0x2a], 23)
  b.writeUInt16LE(width, 26)
  b.writeUInt16LE(height, 28)
  return b
}

function webpLossless(width: number, height: number): Buffer {
  const b = webpHeader("VP8L")
  b[20] = 0x2f
  b.writeUInt32LE((((height - 1) << 14) | (width - 1)) >>> 0, 21)
  return b
}

function webpExtended(width: number, height: number): Buffer {
  const b = webpHeader("VP8X")
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

describe("parseImageSize", () => {
  it("PNG", () => {
    expect(parseImageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  it("GIF", () => {
    expect(parseImageSize(gif(480, 270))).toEqual({ width: 480, height: 270 })
  })

  it("JPEG：跳过帧头之前的段，宽高别读反", () => {
    expect(parseImageSize(jpeg(800, 1200))).toEqual({ width: 800, height: 1200 })
  })

  it("JPEG：帧头之前就遇到图像数据，当作拿不到", () => {
    const sos = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00])
    expect(parseImageSize(sos)).toBeUndefined()
  })

  it("WebP 三种编码：有损、无损、扩展", () => {
    expect(parseImageSize(webpLossy(640, 360))).toEqual({ width: 640, height: 360 })
    expect(parseImageSize(webpLossless(1000, 333))).toEqual({ width: 1000, height: 333 })
    expect(parseImageSize(webpExtended(4000, 3000))).toEqual({ width: 4000, height: 3000 })
  })

  it("认不出的格式、文件残缺、宽高为 0：都是 undefined", () => {
    expect(parseImageSize(Buffer.from("not an image at all, just text"))).toBeUndefined()
    expect(parseImageSize(png(1, 1).subarray(0, 20))).toBeUndefined()
    expect(parseImageSize(Buffer.alloc(0))).toBeUndefined()
    expect(parseImageSize(png(0, 100))).toBeUndefined()
  })
})

describe("readImageFileSize", () => {
  it("读真实 PNG 文件", async () => {
    const icon = fileURLToPath(new URL("../resources/icon.png", import.meta.url))
    expect(await readImageFileSize(icon)).toEqual({ width: 1024, height: 1024 })
  })

  it("文件不存在：undefined", async () => {
    expect(await readImageFileSize("/definitely/not/here.png")).toBeUndefined()
  })
})

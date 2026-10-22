import jsQR from "jsqr"

export interface QrFrame {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** 从一帧 RGBA 像素里识别二维码文本；识别不到返回 null。相机帧用 tryInverted=false 更快 */
export function decodeQrFrame(frame: QrFrame, tryInverted = false): string | null {
  const result = jsQR(frame.data, frame.width, frame.height, {
    inversionAttempts: tryInverted ? "attemptBoth" : "dontInvert",
  })
  return result?.data ? result.data : null
}

const MAX_IMAGE_SIDE = 1600

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("image load failed"))
    img.src = url
  })
}

/** 识别相册 / 截图里的二维码（不依赖相机权限，也不要求安全上下文） */
export async function decodeQrFromFile(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const ratio = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const width = Math.max(1, Math.round(img.naturalWidth * ratio))
    const height = Math.max(1, Math.round(img.naturalHeight * ratio))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, width, height)
    return decodeQrFrame(ctx.getImageData(0, 0, width, height), true)
  } finally {
    URL.revokeObjectURL(url)
  }
}

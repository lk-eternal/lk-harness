import { useEffect, useRef, useState, type ChangeEvent } from "react"
import { Image as ImageIcon, X } from "lucide-react"
import { useBackToClose } from "./back-stack"
import { decodeQrFrame, decodeQrFromFile } from "./qr-decode"

/** getUserMedia 需要安全上下文：App 内是 http://localhost（视为安全），浏览器里要 HTTPS */
function cameraScanSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia
  )
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "没有相机权限，请在系统设置里允许本应用使用相机，或改用相册里的二维码图片"
  }
  if (name === "NotFoundError") return "没有找到可用的相机，可以改用相册里的二维码图片"
  if (name === "NotReadableError") return "相机正被其他应用占用，请关闭后重试"
  return "无法打开相机，可以改用相册里的二维码图片"
}

const SCAN_INTERVAL_MS = 120
const MAX_FRAME_WIDTH = 800
const REJECTED_HINT = "这不是电脑端的配对二维码"

export function QrScanner({
  open,
  onClose,
  onDetect,
}: {
  open: boolean
  onClose: () => void
  /** 返回 true 表示内容已被接受（调用方负责关闭扫描页）；返回 false 则继续扫描 */
  onDetect: (text: string) => boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const detectRef = useRef(onDetect)
  const [cameraError, setCameraError] = useState("")
  const [hint, setHint] = useState("")

  useEffect(() => {
    detectRef.current = onDetect
  })

  useEffect(() => {
    if (!open) return
    setHint("")
    setCameraError("")
    if (!cameraScanSupported()) {
      setCameraError("当前环境无法使用相机预览，可以改用相册里的二维码图片")
      return
    }

    let cancelled = false
    let stream: MediaStream | null = null
    let timer = 0
    let lastRejected = ""
    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    const video = videoRef.current

    const tick = () => {
      if (cancelled || !video || !ctx) return
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, MAX_FRAME_WIDTH / video.videoWidth)
        canvas.width = Math.round(video.videoWidth * scale)
        canvas.height = Math.round(video.videoHeight * scale)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const text = decodeQrFrame(ctx.getImageData(0, 0, canvas.width, canvas.height))
        if (text && text !== lastRejected) {
          if (detectRef.current(text)) return
          lastRejected = text
          setHint(REJECTED_HINT)
        }
      }
      timer = window.setTimeout(tick, SCAN_INTERVAL_MS)
    }

    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        if (!video) return
        video.srcObject = s
        void video.play().catch(() => {})
        tick()
      })
      .catch((err: unknown) => {
        if (!cancelled) setCameraError(cameraErrorMessage(err))
      })

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
      if (video) video.srcObject = null
    }
  }, [open])

  useBackToClose(open, onClose)
  if (!open) return null

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    setHint("正在识别…")
    try {
      const text = await decodeQrFromFile(file)
      if (!text) {
        setHint("图片里没有识别到二维码")
        return
      }
      if (!detectRef.current(text)) setHint(REJECTED_HINT)
    } catch {
      setHint("图片读取失败，请换一张再试")
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black text-white">
      <div className="shrink-0 pt-safe">
        <div className="flex items-center justify-between px-4 py-2">
          <span className="text-sm font-semibold">扫描电脑端的配对二维码</span>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded-lg p-2">
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted autoPlay className="h-full w-full object-cover" />
        {cameraError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black px-8 text-center text-sm leading-relaxed text-white/80">
            {cameraError}
          </div>
        ) : (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-60 w-60 rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
          </div>
        )}
      </div>

      <div className="shrink-0 space-y-3 px-4 pb-safe pt-3 text-center">
        <p className="min-h-4 text-xs text-white/70">
          {hint || "在电脑端「设置 → 手机端」找到二维码，对准取景框"}
        </p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="mx-auto flex items-center gap-1.5 rounded-xl border border-white/30 px-4 py-2.5 text-xs font-medium active:scale-[0.99]"
        >
          <ImageIcon size={14} />从相册选择二维码图片
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void handleFile(e)} />
      </div>
    </div>
  )
}

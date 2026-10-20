import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { ArrowUp, ImagePlus, Square, X } from "lucide-react"
import { primaryCommands } from "../../../shared/command-catalog"

interface Props {
  disabled: boolean
  /** AI 正在工作：输入为空时显示停止按钮 */
  busy: boolean
  /** 底部一行左侧的会话设置（目录、分支、模型等） */
  footer?: ReactNode
  onSend: (text: string, images: string[]) => void
  onStop: () => void
  onError: (message: string) => void
}

interface PendingImage {
  /** 主进程落盘后的绝对路径（随消息发给 Agent） */
  path: string
  /** 仅用于输入框内预览的 blob URL */
  preview: string
}

const MAX_IMAGES = 6
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
}
const MAX_TEXTAREA_PX = 200

/** 输入区：Enter 发送、Shift+Enter 换行；粘贴/拖入/选择图片；`/` 唤起指令菜单 */
export default function Composer({ disabled, busy, footer, onSend, onStop, onError }: Props) {
  const [text, setText] = useState("")
  const [images, setImages] = useState<PendingImage[]>([])
  const [dragging, setDragging] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [menuClosed, setMenuClosed] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imagesRef = useRef(images)
  imagesRef.current = images

  const hasContent = text.trim().length > 0 || images.length > 0

  // 只在输入的是"/指令"本身（尚未出现空格）时给菜单
  const commands = useMemo(() => primaryCommands(), [])
  const slashQuery = /^\/[^\s]*$/.test(text) ? text.toLowerCase() : null
  const menuItems = slashQuery === null || menuClosed ? [] : commands.filter((c) => c.cmd.startsWith(slashQuery))

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`
  }, [text])

  useEffect(() => { setMenuIndex(0) }, [slashQuery])

  // 卸载时释放预览 blob
  useEffect(() => () => { imagesRef.current.forEach((i) => URL.revokeObjectURL(i.preview)) }, [])

  const addImageFiles = async (files: File[]) => {
    const picked = files.filter((f) => f.type.startsWith("image/"))
    if (picked.length === 0) return
    for (const f of picked) {
      if (imagesRef.current.length >= MAX_IMAGES) { onError(`一次最多附带 ${MAX_IMAGES} 张图片`); break }
      const ext = EXT_BY_MIME[f.type]
      if (!ext) { onError(`不支持的图片格式：${f.type}`); continue }
      const r = await window.electronAPI.appChatSaveImage(await f.arrayBuffer(), ext)
      if (!r.ok) { onError(r.error); continue }
      const next = [...imagesRef.current, { path: r.path, preview: URL.createObjectURL(f) }]
      imagesRef.current = next
      setImages(next)
    }
  }

  const removeImage = (path: string) => {
    const hit = images.find((i) => i.path === path)
    if (hit) URL.revokeObjectURL(hit.preview)
    setImages(images.filter((i) => i.path !== path))
  }

  const submit = () => {
    if (!hasContent || disabled) return
    onSend(text.trim(), images.map((i) => i.path))
    images.forEach((i) => URL.revokeObjectURL(i.preview))
    setImages([])
    setText("")
    setMenuClosed(false)
  }

  const pickCommand = (cmd: string) => {
    setText(`${cmd} `)
    textareaRef.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (menuItems.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenuIndex((i) => (i + 1) % menuItems.length); return }
      if (e.key === "ArrowUp") { e.preventDefault(); setMenuIndex((i) => (i - 1 + menuItems.length) % menuItems.length); return }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && text.trim() !== menuItems[menuIndex].cmd)) {
        e.preventDefault()
        pickCommand(menuItems[menuIndex].cmd)
        return
      }
      if (e.key === "Escape") { e.preventDefault(); setMenuClosed(true); return }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="shrink-0 px-6 pb-4 pt-2">
      <div className="relative mx-auto max-w-3xl">
        {menuItems.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-lg border border-line bg-page py-1 shadow-lg">
            {menuItems.map((c, i) => (
              <button
                key={c.cmd}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pickCommand(c.cmd) }}
                onMouseEnter={() => setMenuIndex(i)}
                className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-xs ${i === menuIndex ? "bg-raised" : ""}`}
              >
                <span className="shrink-0 font-mono text-accent-soft">{c.cmd}</span>
                <span className="min-w-0 flex-1 truncate text-fg-muted">{c.desc}</span>
              </button>
            ))}
          </div>
        )}

        <div
          onDragOver={(e) => { if (!disabled && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true) } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            setDragging(false)
            if (disabled) return
            const files = Array.from(e.dataTransfer.files)
            if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void addImageFiles(files) }
          }}
          className={`rounded-2xl border bg-page shadow-sm transition ${dragging ? "border-blue-500" : "border-line focus-within:border-blue-500"} ${disabled ? "opacity-50" : ""}`}
        >
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {images.map((i) => (
                <div key={i.path} className="group relative">
                  <img src={i.preview} alt="" className="h-16 w-16 rounded object-cover" />
                  <button
                    type="button"
                    onClick={() => removeImage(i.path)}
                    title="移除"
                    className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-strong p-0.5 text-fg-soft hover:bg-red-600 group-hover:block"
                  ><X size={11} /></button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            disabled={disabled}
            onChange={(e) => { setText(e.target.value); setMenuClosed(false) }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files)
              if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void addImageFiles(files) }
            }}
            placeholder={disabled ? "请先选择或新建会话" : busy ? "Agent 运行中，发送的消息会排队…" : "输入消息，/ 唤起指令，Enter 发送，Shift+Enter 换行"}
            className="block max-h-[200px] min-h-[3.5rem] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-sm outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
            {footer}
            <span className="flex-1" />
            <button
              type="button"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              title="添加图片"
              className="rounded-lg p-1.5 text-fg-muted transition hover:bg-raised hover:text-fg-soft disabled:opacity-40"
            ><ImagePlus size={17} /></button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
              multiple
              className="hidden"
              onChange={(e) => {
                void addImageFiles(Array.from(e.target.files ?? []))
                e.target.value = ""
              }}
            />
            {busy && !hasContent ? (
              <button type="button" onClick={onStop} title="停止并清空排队消息" className="flex h-8 w-8 items-center justify-center rounded-full bg-red-600 text-white transition hover:bg-red-500"><Square size={14} /></button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={disabled || !hasContent}
                title="发送"
                className={`flex h-8 w-8 items-center justify-center rounded-full transition ${hasContent && !disabled ? "bg-blue-600 text-white hover:bg-blue-500" : "bg-strong text-fg-faint"}`}
              ><ArrowUp size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

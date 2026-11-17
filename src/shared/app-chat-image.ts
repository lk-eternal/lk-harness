// ── 应用内对话的图片：哪些文件算图片、多大以内、读不出来时界面怎么说 ─────────────────
// 主进程（读图、复制、另存）、daemon（把图片收进会话目录）和界面共用这一份，免得几边的判断对不上。
// 这里不依赖 node 模块：界面（渲染进程）也要用。

export const APP_CHAT_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

export const MAX_APP_CHAT_IMAGE_BYTES = 20 * 1024 * 1024

/** 读图时文件已经不在磁盘上的报错；界面据此区分「被清理了」和别的读取失败 */
export const APP_CHAT_IMAGE_MISSING = "文件不存在"

/** 按扩展名给 MIME；不是支持的图片格式返回 undefined（和 path.extname 一样：点开头的隐藏文件不算扩展名） */
export function appChatImageMime(file: string): string | undefined {
  const m = /[^\\/]\.([A-Za-z0-9]+)$/.exec(file)
  return m ? APP_CHAT_IMAGE_MIME[`.${m[1].toLowerCase()}`] : undefined
}

export interface ImageFailureView {
  /** 占位上显示的字 */
  label: string
  /** 悬停提示 */
  hint: string
}

/** 读图失败时的占位：文件已经不在磁盘上，是被清掉或删掉了；其他原因（格式、过大、读取出错）照实说 */
export function imageFailureView(error: string | undefined, file: string): ImageFailureView {
  if (error === APP_CHAT_IMAGE_MISSING) {
    return { label: "图片已被清理", hint: `图片文件已不在磁盘上（可能被清理工具或系统删除）：${file}` }
  }
  return { label: "图片不可用", hint: `${error || "读取失败"}：${file}` }
}

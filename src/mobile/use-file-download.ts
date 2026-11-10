import { useState } from "react"
import { startFileDownload } from "./native-browser"

/**
 * 「下载」按钮的状态：getUrl 先换一张短时下载票据（令牌不进 URL），再交给系统去下载。
 * 进行中和失败原因给界面显示；进行中再点不会重复发起。
 */
export function useFileDownload() {
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState("")

  const start = async (getUrl: () => Promise<string>, fileName: string) => {
    if (downloading) return
    setDownloading(true)
    setError("")
    try {
      await startFileDownload(await getUrl(), fileName)
    } catch (err) {
      setError(err instanceof Error ? err.message : "下载失败")
    } finally {
      setDownloading(false)
    }
  }

  return { downloading, error, start }
}

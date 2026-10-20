import { useEffect, useState } from "react"
import logoUrl from "../assets/logo.png"

/** 标题栏左侧：logo + 应用名 + 版本号（工作台和对话页共用） */
export default function TitleBrand() {
  const [version, setVersion] = useState("")

  useEffect(() => {
    void window.electronAPI.getAppVersion().then(setVersion)
  }, [])

  return (
    <div className="flex items-center gap-3">
      <img src={logoUrl} alt="logo" className="h-6 w-6" />
      <h1 className="text-lg font-semibold">LK Harness</h1>
      {version && (
        <span className="rounded bg-raised px-2 py-0.5 text-xs text-fg-3">
          v{version}
        </span>
      )}
    </div>
  )
}

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { fetchUpdateInfo } from "./api"
import { APP_VERSION } from "./app-version"
import { isNativeShell, tryOpenInSystemBrowser } from "./native-browser"
import { createUpdateController } from "./update-controller"
import { loadDismissedUpdate, saveDismissedUpdate } from "./update-check"

/**
 * App（APK）的更新检查，只在 App 里生效；网页版由电脑端直接提供，版本天然一致，不查。
 * 流程见 update-controller.ts：连上电脑端查一次，之后每次回到前台再查，失败自己重试，菜单里可手动检查。
 */
export function useAppUpdate(opts: {
  /** 手机当前连着的电脑地址 */
  baseUrl: string
  token: string
  connected: boolean
  onError: (message: string) => void
}) {
  const optsRef = useRef(opts)
  optsRef.current = opts
  const [isApp] = useState(isNativeShell)
  const [controller] = useState(() =>
    createUpdateController({
      fetchInfo: () => fetchUpdateInfo(optsRef.current.baseUrl, optsRef.current.token),
      getBaseUrl: () => optsRef.current.baseUrl,
      currentVersion: APP_VERSION,
      loadDismissed: loadDismissedUpdate,
      saveDismissed: saveDismissedUpdate,
      openUrl: tryOpenInSystemBrowser,
      onError: (message) => optsRef.current.onError(message),
    }),
  )
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  useEffect(() => {
    if (!isApp || !opts.connected || !opts.baseUrl || !opts.token) return
    controller.autoCheck()
    // App 常驻后台，可能几天才重新启动一次：每次切回前台都问一下（控制器自己限制频率）
    const onVisible = () => {
      if (document.visibilityState === "visible") controller.autoCheck()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [isApp, opts.connected, opts.baseUrl, opts.token, controller])

  useEffect(() => () => controller.stop(), [controller])

  return {
    isApp,
    currentVersion: APP_VERSION,
    update: state.update,
    status: state.status,
    checkNow: controller.checkNow,
    startUpdate: () => void controller.startUpdate(),
    dismiss: controller.dismiss,
  }
}

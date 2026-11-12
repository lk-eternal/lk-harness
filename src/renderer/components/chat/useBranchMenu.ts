import { useCallback, useEffect, useRef, useState } from "react"
import { branchKey, type BranchListData, type BranchListResult, type BranchOption, type BranchSwitchResult } from "../../../shared/git-branch"

export interface BranchMenuApi {
  load: () => Promise<BranchListResult>
  switchTo: (target: { name: string; kind: BranchOption["kind"]; remote?: string }) => Promise<BranchSwitchResult>
}

export interface BranchMenu {
  /** 菜单打开期间读到的分支列表；还没读到（或没打开）为 null */
  data: BranchListData | null
  loading: boolean
  /** 读列表或切换失败的原因；留在菜单里显示，直到下一次操作 */
  error: string
  /** 正在切到的那个分支（branchKey）；没有在切为 null */
  switching: string | null
  /** 选一个分支切过去；返回切换结果，没发起（已有切换在进行）返回 undefined */
  choose: (option: BranchOption) => Promise<BranchSwitchResult | undefined>
}

/**
 * 分支菜单的数据：打开时现读一次分支列表（不用缓存——你可能刚在终端里切过、建过分支），
 * 关上就清空，下次打开重新读。桌面端的下拉菜单和手机端的底部抽屉共用。
 */
export function useBranchMenu(open: boolean, api: BranchMenuApi): BranchMenu {
  const [data, setData] = useState<BranchListData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [switching, setSwitching] = useState<string | null>(null)
  const apiRef = useRef(api)
  apiRef.current = api
  const seq = useRef(0)
  const switchingRef = useRef(false)

  useEffect(() => {
    if (!open) {
      seq.current += 1
      setData(null)
      setError("")
      setLoading(false)
      return
    }
    const id = ++seq.current
    setLoading(true)
    setError("")
    apiRef.current.load().then(
      (r) => {
        if (id !== seq.current) return
        setLoading(false)
        if (r.ok) setData(r)
        else setError(r.error)
      },
      (e: unknown) => {
        if (id !== seq.current) return
        setLoading(false)
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }, [open])

  const choose = useCallback(async (option: BranchOption): Promise<BranchSwitchResult | undefined> => {
    if (switchingRef.current) return undefined
    switchingRef.current = true
    setSwitching(branchKey(option))
    setError("")
    let r: BranchSwitchResult
    try {
      r = await apiRef.current.switchTo({ name: option.name, kind: option.kind, ...(option.remote ? { remote: option.remote } : {}) })
    } catch (e: unknown) {
      r = { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    switchingRef.current = false
    setSwitching(null)
    if (!r.ok) setError(r.error)
    return r
  }, [])

  return { data, loading, error, switching, choose }
}

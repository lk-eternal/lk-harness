import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { CheckCircle2, ChevronDown, ChevronRight, Copy, Eye, EyeOff, FolderOpen, Plus, X } from "lucide-react"
import useInlineModal from "../useInlineModal"
import { repoIdentityKey } from "../../../shared/project-app-types"
import {
  buildSettingsPatch,
  type ProjectSettingsField, type ProjectSettingsValues, type RepoProfileRow,
} from "../../../shared/project-settings-patch"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"
const smallBtn = "shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-fg-2 transition hover:bg-raised disabled:opacity-50"

const EMPTY: ProjectSettingsValues = {
  worktreeRoot: "", gitlabToken: "", gitlabHost: "", repoProfiles: [], flowHubUrl: "", flowHubToken: "", flowHubAuthor: "",
}

/** 可折叠的设置块：不常用的放在里面，默认收起 */
function Fold({ title, hint, open, onToggle, children }: {
  title: string
  hint: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-line-subtle">
      <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left">
        {open ? <ChevronDown size={14} className="text-fg-muted" /> : <ChevronRight size={14} className="text-fg-muted" />}
        <span className="text-sm font-medium text-fg-2">{title}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-fg-faint">{hint}</span>
      </button>
      {open && <div className="space-y-4 border-t border-line-subtle px-3 py-3">{children}</div>}
    </section>
  )
}

/** 密钥输入框：默认遮住，可显示、可复制 */
function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input type={shown ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${inputCls} pr-16`} />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <button type="button" title="复制" disabled={!value.trim()} onClick={() => void navigator.clipboard.writeText(value)} className="text-fg-muted hover:text-fg-2 disabled:opacity-40"><Copy size={13} /></button>
        <button type="button" title={shown ? "隐藏" : "显示"} onClick={() => setShown(!shown)} className="text-fg-muted hover:text-fg-2">{shown ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      </div>
    </div>
  )
}

/**
 * 项目设置：项目存放位置。
 * 代码仓库、GitLab 只有做研发类项目才用得到，放在「研发（可选）」里；
 * 团队共享（共享空间）个人用不到，放在「团队共享（高级）」里。两块默认收起，配置过的自动展开。
 */
export default function ProjectSettingsPanel() {
  const { showAlert, ModalPortal } = useInlineModal()
  const [values, setValues] = useState<ProjectSettingsValues>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [defaultRoot, setDefaultRoot] = useState("")
  const [devOpen, setDevOpen] = useState(false)
  const [hubOpen, setHubOpen] = useState(false)
  const [moreRows, setMoreRows] = useState<Record<number, boolean>>({})
  const [saved, setSaved] = useState(false)

  const valuesRef = useRef<ProjectSettingsValues>(EMPTY)
  const touched = useRef(new Set<ProjectSettingsField>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)

  /** 立刻把改过的项写回配置（只写改过的项） */
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined }
    const fields = [...touched.current]
    if (!fields.length) return
    touched.current.clear()
    await window.electronAPI.saveConfig(buildSettingsPatch(fields, valuesRef.current))
    if (!mounted.current) return
    setSaved(true)
    setTimeout(() => { if (mounted.current) setSaved(false) }, 1500)
  }, [])

  const update = useCallback(<K extends ProjectSettingsField>(key: K, val: ProjectSettingsValues[K]) => {
    valuesRef.current = { ...valuesRef.current, [key]: val }
    setValues(valuesRef.current)
    touched.current.add(key)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 500)
  }, [flush])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; void flush() }
  }, [flush])

  useEffect(() => {
    let alive = true
    void Promise.all([
      window.electronAPI.getConfig(),
      window.electronAPI.getProjectsRootDir().catch(() => ""),
    ]).then(([config, root]) => {
      if (!alive) return
      const profiles: RepoProfileRow[] = config.repoProfiles?.length
        ? config.repoProfiles.map((p) => ({ ...p }))
        : (config.repoRoots ?? []).map((p) => ({ path: p, baseBranch: "" }))
      const next: ProjectSettingsValues = {
        worktreeRoot: config.worktreeRoot ?? "",
        gitlabToken: config.gitlabToken ?? "",
        gitlabHost: config.gitlabHost ?? "",
        repoProfiles: profiles,
        flowHubUrl: config.flowHubUrl ?? "",
        flowHubToken: config.flowHubToken ?? "",
        flowHubAuthor: config.flowHubAuthor ?? "",
      }
      valuesRef.current = next
      setValues(next)
      setDefaultRoot(root)
      setDevOpen(profiles.length > 0 || !!next.gitlabToken.trim() || !!next.gitlabHost.trim())
      setHubOpen(!!next.flowHubUrl.trim() || !!next.flowHubToken.trim())
      setMoreRows(Object.fromEntries(profiles.map((p, i) => [i, !!(p.testBranch || p.developBranch)])))
      setLoaded(true)
    })
    return () => { alive = false }
  }, [])

  const setProfile = (i: number, patch: Partial<RepoProfileRow>) =>
    update("repoProfiles", values.repoProfiles.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const removeProfile = (i: number) => {
    update("repoProfiles", values.repoProfiles.filter((_, j) => j !== i))
    setMoreRows({})
  }

  const addLocalRepo = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    const r = await window.electronAPI.inspectProjectRepo(dir)
    if (!r.ok) { void showAlert("不能添加这个文件夹", r.error); return }
    // 选文件夹要等一会儿，用最新的列表，不用点按钮时的快照
    const cur = valuesRef.current.repoProfiles
    if (cur.some((p) => repoIdentityKey(p.path) === repoIdentityKey(r.path))) {
      void showAlert("已经在列表里了", `「${r.name}」已经添加过了。`)
      return
    }
    update("repoProfiles", [...cur, { path: r.path, baseBranch: r.baseBranch }])
  }

  const pickRoot = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) update("worktreeRoot", dir)
  }

  if (!loaded) return <div className="flex-1 p-6 text-sm text-fg-muted">加载中…</div>

  const effectiveRoot = values.worktreeRoot.trim() || defaultRoot

  return (
    <div className="flex-1 overflow-y-auto pb-6 pr-4">
      <div className="max-w-xl space-y-5">
        <div className="flex h-6 items-center justify-between">
          <h3 className="text-sm font-medium text-fg-2">项目设置</h3>
          {saved && <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={14} />已保存</span>}
        </div>

        <section className="space-y-2">
          <h4 className="text-xs font-medium text-fg-3">项目存放位置</h4>
          <p className="text-xs leading-relaxed text-fg-muted">
            新建项目时，应用会在这里给每个项目建一个文件夹：成果都放在里面，研发项目的代码副本也放这里。只影响之后新建的项目，已经建好的不会搬家。
          </p>
          <div className="flex gap-2">
            <input type="text" value={values.worktreeRoot} onChange={(e) => update("worktreeRoot", e.target.value)} placeholder={defaultRoot || "默认：应用数据目录下的 claw-projects"} className={inputCls} />
            <button type="button" onClick={() => void pickRoot()} className={smallBtn}>浏览</button>
          </div>
          {effectiveRoot && (
            <p className="break-all text-[11px] text-fg-faint">
              {values.worktreeRoot.trim() ? "当前位置：" : "当前使用默认位置："}{effectiveRoot}
            </p>
          )}
        </section>

        <Fold title="研发（可选）" hint="只有用「开发」类项目才需要" open={devOpen} onToggle={() => setDevOpen(!devOpen)}>
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-fg-3">常用代码仓库</h4>
            <p className="text-xs leading-relaxed text-fg-muted">
              新建「开发」类项目时可以直接勾选。建过项目的仓库会自动记在这里，不用提前配。基线分支是新分支从哪里切出去（一般是主干或生产分支）。
            </p>
            <div className="space-y-2">
              {values.repoProfiles.map((p, i) => (
                <div key={i} className="rounded-lg border border-line-subtle p-2">
                  <div className="flex items-center gap-2">
                    <input type="text" value={p.path} placeholder="D:\repos\foo 或 https://…/foo.git"
                      onChange={(e) => setProfile(i, { path: e.target.value })} className={`${inputCls} flex-[3]`} />
                    <input type="text" value={p.baseBranch} placeholder="基线分支"
                      onChange={(e) => setProfile(i, { baseBranch: e.target.value })} className={`${inputCls} flex-1`} />
                    <button type="button" title="移除" onClick={() => removeProfile(i)}
                      className="shrink-0 rounded-md border border-line p-1.5 text-fg-3 hover:bg-raised hover:text-danger"><X size={13} /></button>
                  </div>
                  <button type="button" onClick={() => setMoreRows((m) => ({ ...m, [i]: !m[i] }))}
                    className="mt-1.5 text-[11px] text-fg-muted hover:text-fg-2">{moreRows[i] ? "收起" : "更多分支设置（测试 / 开发分支，可不填）"}</button>
                  {moreRows[i] && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <input type="text" value={p.testBranch ?? ""} placeholder="测试分支"
                        onChange={(e) => setProfile(i, { testBranch: e.target.value || undefined })} className={`${inputCls} flex-1`} />
                      <input type="text" value={p.developBranch ?? ""} placeholder="开发分支"
                        onChange={(e) => setProfile(i, { developBranch: e.target.value || undefined })} className={`${inputCls} flex-1`} />
                    </div>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void addLocalRepo()} className={`${smallBtn} inline-flex items-center gap-1`}><FolderOpen size={13} />添加本地仓库</button>
                <button type="button" onClick={() => update("repoProfiles", [...values.repoProfiles, { path: "", baseBranch: "" }])}
                  className={`${smallBtn} inline-flex items-center gap-1 border-dashed`}><Plus size={13} />手动输入路径或地址</button>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h4 className="text-xs font-medium text-fg-3">GitLab</h4>
            <p className="text-xs leading-relaxed text-fg-muted">
              只用来让 AI 查找、查看 MR（合并请求）。不需要这个功能就不用填，不影响建项目、改代码和推分支。
            </p>
            <div>
              <label className="mb-1 block text-xs text-fg-muted">GitLab Token</label>
              <SecretInput value={values.gitlabToken} onChange={(v) => update("gitlabToken", v)} placeholder="glpat-..." />
            </div>
            <div>
              <label className="mb-1 block text-xs text-fg-muted">GitLab 地址（可不填，默认从仓库的 origin 推断）</label>
              <input type="text" value={values.gitlabHost} onChange={(e) => update("gitlabHost", e.target.value)} placeholder="https://gitlab.com" className={inputCls} />
            </div>
          </div>
        </Fold>

        <Fold title="团队共享（高级）" hint="个人使用不需要" open={hubOpen} onToggle={() => setHubOpen(!hubOpen)}>
          <p className="text-xs leading-relaxed text-fg-muted">
            把项目模板上传到团队共用的一个 GitLab 仓库（共享空间），同事就能直接获取。只有想和同事共用模板时才需要配；
            不配也完全可以：在「项目模板」里导出文件发给对方，对方导入就行。
          </p>
          <div>
            <label className="mb-1 block text-xs text-fg-muted">共享空间地址</label>
            <input type="text" value={values.flowHubUrl} onChange={(e) => update("flowHubUrl", e.target.value)} placeholder="https://gitlab.example.com/group/your-flow-hub" className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-fg-muted">共享空间 Token（需要 Maintainer 及以上权限）</label>
            <SecretInput value={values.flowHubToken} onChange={(v) => update("flowHubToken", v)} placeholder="glpat-..." />
            <p className="mt-1 text-[11px] text-fg-faint">不填的话，会改用「研发」里的 GitLab Token。</p>
          </div>
          <div>
            <label className="mb-1 block text-xs text-fg-muted">你的名字（上传时显示给同事）</label>
            <input type="text" value={values.flowHubAuthor} onChange={(e) => update("flowHubAuthor", e.target.value)} placeholder="你的名字" className={inputCls} />
          </div>
        </Fold>
      </div>
      {ModalPortal}
    </div>
  )
}

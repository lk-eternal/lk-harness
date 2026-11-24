import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { CheckCircle2, Copy, Eye, EyeOff, FolderOpen, Plus, X } from "lucide-react"
import useInlineModal from "../useInlineModal"
import { isRemoteRepoUrl, repoIdentityKey } from "../../../shared/project-app-types"
import { DEFAULT_GIT_PRINCIPLES, GIT_PRINCIPLES_MAX, resolveGitPrinciples } from "../../../shared/project-git-principles"
import {
  buildSettingsPatch,
  type ProjectSettingsField, type ProjectSettingsValues, type RepoProfileRow,
} from "../../../shared/project-settings-patch"

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-focus"
/** 表格里的输入框：比表单里的矮一点，一行放得下一个仓库的全部信息 */
const cellCls = "w-full min-w-0 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm outline-none transition placeholder:text-fg-faint focus:border-focus"
const smallBtn = "shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-fg-2 transition hover:bg-raised disabled:opacity-50"

/**
 * 仓库表格，按所在卡片的宽度（容器查询，不是窗口宽度）切换两种排法：
 * - 够宽（≥ 42rem）：一个仓库一行，列是 地址 | 基线分支 | 测试分支 | 开发分支 | 克隆副本 | 移除，表头和每一行共用同一套列宽，上下对得齐；
 * - 放不下（应用默认窗口就是）：一个仓库一张小卡片，第一行地址和移除，第二行三个分支（各带小标签），第三行克隆副本的勾选。
 * 不做横向滚动：滚动条一藏起来，右边的列用户就不知道还有。
 */
const REPO_WIDE_COLS = "@[42rem]:grid-cols-[minmax(11rem,1fr)_7rem_7rem_7rem_4.5rem_1.75rem]"
const REPO_ROW = `grid grid-cols-[minmax(0,1fr)_1.75rem] items-center gap-x-2 gap-y-1.5 ${REPO_WIDE_COLS}`

const EMPTY: ProjectSettingsValues = {
  worktreeRoot: "", gitlabToken: "", gitlabHost: "", repoProfiles: [], gitPrinciples: "", flowHubUrl: "", flowHubToken: "", flowHubAuthor: "",
}

/** 一块设置：标题（可带一个灰色小标签）+ 一句说明 + 内容。全部直接展开，不折叠 */
function Card({ title, tag, hint, children }: { title: string; tag?: string; hint: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line-subtle">
      <div className="px-4 pt-3">
        <div className="flex items-baseline gap-2">
          <h4 className="text-sm font-medium text-fg-2">{title}</h4>
          {tag && <span className="text-[11px] text-fg-faint">{tag}</span>}
        </div>
        <p className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">{hint}</p>
      </div>
      <div className="px-4 pb-4 pt-3">{children}</div>
    </section>
  )
}

/** 表单行：左边是名字，右边是输入框；各行的输入框左边对齐。note 是输入框下面的小提示 */
function Row({ label, htmlFor, note, children }: { label: string; htmlFor: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-start gap-x-4">
      <label htmlFor={htmlFor} className="pt-2 text-xs text-fg-3">{label}</label>
      <div className="min-w-0">
        {children}
        {note && <p className="mt-1 text-[11px] leading-snug text-fg-faint">{note}</p>}
      </div>
    </div>
  )
}

/** 仓库行里的一个分支框：窄排法里上面有小标签，宽排法里标签藏起来（表头已经写了） */
function BranchCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-0.5 block text-[10.5px] text-fg-muted @[42rem]:hidden">{label}</span>
      {children}
    </label>
  )
}

/** 密钥输入框：默认遮住，可显示、可复制 */
function SecretInput({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <input id={id} type={shown ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" className={`${inputCls} pr-16`} />
      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        <button type="button" title="复制" disabled={!value.trim()} onClick={() => void navigator.clipboard.writeText(value)} className="text-fg-muted hover:text-fg-2 disabled:opacity-40"><Copy size={13} /></button>
        <button type="button" title={shown ? "隐藏" : "显示"} onClick={() => setShown(!shown)} className="text-fg-muted hover:text-fg-2">{shown ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      </div>
    </div>
  )
}

/**
 * 项目设置：项目存放位置、常用代码仓库、GitLab、团队共享（共享空间）四块，全部直接展开。
 * 后三块只有做开发类项目、或想和同事共用模板时才用得到，标题旁的小标签说明了这一点；不用的留空就行。
 */
export default function ProjectSettingsPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const { showAlert, ModalPortal } = useInlineModal()
  const [values, setValues] = useState<ProjectSettingsValues>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [defaultRoot, setDefaultRoot] = useState("")
  const [saved, setSaved] = useState(false)

  const valuesRef = useRef<ProjectSettingsValues>(EMPTY)
  const touched = useRef(new Set<ProjectSettingsField>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  // 用 ref 拿最新的回调：flush 要保持引用不变（卸载时靠它把没存的改动写出去）
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  // 刚手动加的那一行：新行出现时把光标放进它的地址框。渲染后清掉，之后重新渲染不会再抢焦点
  const focusRow = useRef<number | null>(null)
  useEffect(() => { focusRow.current = null })

  /** 立刻把改过的项写回配置（只写改过的项） */
  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = undefined }
    const fields = [...touched.current]
    if (!fields.length) return
    touched.current.clear()
    await window.electronAPI.saveConfig(buildSettingsPatch(fields, valuesRef.current))
    // 页面已经切走时也要通知：上层（项目页）自己存着一份「共享空间配没配好」，不通知就一直是旧的
    onSavedRef.current?.()
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
        gitPrinciples: resolveGitPrinciples(config.gitPrinciples),
        flowHubUrl: config.flowHubUrl ?? "",
        flowHubToken: config.flowHubToken ?? "",
        flowHubAuthor: config.flowHubAuthor ?? "",
      }
      valuesRef.current = next
      setValues(next)
      setDefaultRoot(root)
      setLoaded(true)
    })
    return () => { alive = false }
  }, [])

  // 改哪一行都以最新的列表为准（连着快速输入时，渲染时的快照可能还是上一次的）
  const setProfile = (i: number, patch: Partial<RepoProfileRow>) =>
    update("repoProfiles", valuesRef.current.repoProfiles.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const removeProfile = (i: number) =>
    update("repoProfiles", valuesRef.current.repoProfiles.filter((_, j) => j !== i))

  const addBlankRepo = () => {
    const cur = valuesRef.current.repoProfiles
    focusRow.current = cur.length
    update("repoProfiles", [...cur, { path: "", baseBranch: "" }])
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
    // 输入框一失焦就存：刚敲完 Token 立刻去点别处（比如左栏的「共享空间」）时，不用等防抖，别处读到的就是新值
    <div className="flex-1 overflow-y-auto pb-6 pr-4" onBlur={() => void flush()}>
      <div className="max-w-4xl space-y-4">
        <div className="flex h-6 items-center justify-between">
          <h3 className="text-sm font-medium text-fg-2">项目设置</h3>
          {saved && <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 size={14} />已保存</span>}
        </div>

        <Card
          title="项目存放位置"
          hint="新建项目时，应用会在这里给每个项目建一个文件夹：成果都放在里面，勾了「克隆副本」的代码仓库也会克隆到这里。只影响之后新建的项目，已经建好的不会搬家。"
        >
          <Row label="存放文件夹" htmlFor="ps-worktree-root" note={effectiveRoot ? <span className="break-all">{values.worktreeRoot.trim() ? "当前位置：" : "当前使用默认位置："}{effectiveRoot}</span> : undefined}>
            <div className="flex gap-2">
              <input id="ps-worktree-root" type="text" value={values.worktreeRoot} onChange={(e) => update("worktreeRoot", e.target.value)} placeholder={defaultRoot || "默认：应用数据目录下的 claw-projects"} className={inputCls} />
              <button type="button" onClick={() => void pickRoot()} className={smallBtn}>浏览</button>
            </div>
          </Row>
        </Card>

        <Card
          title="常用代码仓库"
          tag="新建接代码仓库的项目时用"
          hint={<>
            新建项目时可以直接勾选；建过项目的仓库会自动记在这里，不用提前配。基线分支是新分支从哪里切出去（一般是主干或生产分支），测试、开发分支可以不填。
            <br />
            「克隆副本」：勾上，建项目时会克隆一份到项目目录，AI 在副本里改，不动你自己的仓库；不勾就不克隆，只把仓库信息记进项目，AI 直接用你本机这份（应用不会去动它）。远程地址本机没有副本，一律克隆。
          </>}
        >
          {values.repoProfiles.length > 0 ? (
            <div className="@container">
              <div className={`hidden items-center gap-2 pb-1.5 text-[11px] text-fg-muted @[42rem]:grid ${REPO_WIDE_COLS}`}>
                <span>仓库地址或本地路径</span>
                <span title="新分支从哪里切出去（一般是主干或生产分支）">基线分支</span>
                <span>测试分支</span>
                <span>开发分支</span>
                <span title="勾上：建项目时克隆一份副本到项目目录，AI 在副本里改，不动你自己的仓库。不勾：不克隆，AI 直接用你本机这份">克隆副本</span>
                <span />
              </div>
              <div className="space-y-2 @[42rem]:space-y-1.5">
                {values.repoProfiles.map((p, i) => (
                  <div key={i} className={`${REPO_ROW} rounded-lg border border-line-subtle p-2 @[42rem]:rounded-none @[42rem]:border-0 @[42rem]:p-0`}>
                    <input type="text" aria-label="仓库地址或本地路径" title={p.path} spellCheck={false} autoFocus={focusRow.current === i}
                      value={p.path} placeholder="D:\repos\foo 或 https://…/foo.git"
                      onChange={(e) => setProfile(i, { path: e.target.value })}
                      className={`${cellCls} col-start-1 row-start-1 @[42rem]:col-auto @[42rem]:row-auto`} />
                    {/* 宽排法里这层不存在（contents），三个分支框直接排进上面那一行的列里 */}
                    <div className="col-span-2 row-start-2 grid grid-cols-3 gap-2 @[42rem]:contents">
                      <BranchCell label="基线分支">
                        <input type="text" aria-label="基线分支" spellCheck={false}
                          value={p.baseBranch} placeholder="如 master"
                          onChange={(e) => setProfile(i, { baseBranch: e.target.value })} className={cellCls} />
                      </BranchCell>
                      <BranchCell label="测试分支">
                        <input type="text" aria-label="测试分支" spellCheck={false}
                          value={p.testBranch ?? ""} placeholder="可不填"
                          onChange={(e) => setProfile(i, { testBranch: e.target.value || undefined })} className={cellCls} />
                      </BranchCell>
                      <BranchCell label="开发分支">
                        <input type="text" aria-label="开发分支" spellCheck={false}
                          value={p.developBranch ?? ""} placeholder="可不填"
                          onChange={(e) => setProfile(i, { developBranch: e.target.value || undefined })} className={cellCls} />
                      </BranchCell>
                      {/* 窄排法里单独占一行；宽排法里是「克隆副本」那一列 */}
                      <label
                        className="col-span-3 flex items-center gap-1.5 text-[11.5px] text-fg-muted @[42rem]:col-auto @[42rem]:justify-center"
                        title={isRemoteRepoUrl(p.path) ? "远程地址本机没有副本可用，一定会克隆" : "勾上：建项目时克隆一份副本到项目目录，AI 在副本里改，不动你自己的仓库。不勾：不克隆，只把仓库信息记进项目，AI 直接用你本机这份"}
                      >
                        <input type="checkbox" aria-label="克隆副本" className="h-3.5 w-3.5 accent-primary"
                          checked={isRemoteRepoUrl(p.path) || p.clone !== false}
                          disabled={isRemoteRepoUrl(p.path)}
                          onChange={(e) => setProfile(i, { clone: e.target.checked ? undefined : false })} />
                        <span className="@[42rem]:hidden">克隆副本{isRemoteRepoUrl(p.path) ? "（远程地址一定会克隆）" : ""}</span>
                      </label>
                    </div>
                    <button type="button" title="移除这个仓库" aria-label="移除这个仓库" onClick={() => removeProfile(i)}
                      className="col-start-2 row-start-1 flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition hover:bg-raised hover:text-danger @[42rem]:col-auto @[42rem]:row-auto"><X size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-xs text-fg-muted">还没有常用仓库。建项目时用过的仓库会自动记在这里，也可以在下面手动添加。</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void addLocalRepo()} className={`${smallBtn} inline-flex items-center gap-1`}><FolderOpen size={13} />添加本地仓库</button>
            <button type="button" onClick={addBlankRepo} className={`${smallBtn} inline-flex items-center gap-1 border-dashed`}><Plus size={13} />手动添加一行</button>
          </div>
        </Card>

        <Card
          title="Git 基本原则"
          tag="项目里有代码仓库时带给 AI"
          hint="项目里记了代码仓库的话，每个项目会话开头都会带上这段话，防 AI 在 Git 上犯傻（合错分支、乱解冲突、force push 之类）。可以按团队习惯改；清空就不带。分支怎么用、什么时候提交推送，仍然由项目模板里每个步骤的提示词决定。"
        >
          <textarea
            id="ps-git-principles"
            aria-label="Git 基本原则"
            value={values.gitPrinciples}
            maxLength={GIT_PRINCIPLES_MAX}
            rows={10}
            spellCheck={false}
            onChange={(e) => update("gitPrinciples", e.target.value)}
            className={`${inputCls} resize-y font-mono text-[12.5px] leading-relaxed`}
          />
          <div className="mt-2 flex items-center gap-3 text-[11.5px] text-fg-muted">
            <button
              type="button"
              disabled={values.gitPrinciples.replace(/\r\n/g, "\n").trim() === DEFAULT_GIT_PRINCIPLES}
              onClick={() => update("gitPrinciples", DEFAULT_GIT_PRINCIPLES)}
              className={smallBtn}
            >恢复默认</button>
            {!values.gitPrinciples.trim() && <span>现在是空的：项目会话里不会带这段话。</span>}
          </div>
        </Card>

        <Card
          title="GitLab"
          tag="可选"
          hint="用来访问团队共享（共享空间）所在的 GitLab：共享空间那边没单独配 Token / 地址时，用这里的。不用共享空间就不用填，不影响建项目、改代码和推分支。"
        >
          <div className="space-y-3">
            <Row label="GitLab Token" htmlFor="ps-gitlab-token">
              <SecretInput id="ps-gitlab-token" value={values.gitlabToken} onChange={(v) => update("gitlabToken", v)} placeholder="glpat-..." />
            </Row>
            <Row label="GitLab 地址" htmlFor="ps-gitlab-host" note="可不填，默认从仓库的 origin 推断">
              <input id="ps-gitlab-host" type="text" value={values.gitlabHost} onChange={(e) => update("gitlabHost", e.target.value)} placeholder="https://gitlab.com" className={inputCls} />
            </Row>
          </div>
        </Card>

        <Card
          title="团队共享"
          tag="共享空间 · 可选"
          hint="把项目模板上传到团队共用的一个 GitLab 仓库（共享空间），同事就能直接获取。不配也完全可以：在「项目模板」里导出文件发给对方，对方导入就行。"
        >
          <div className="space-y-3">
            <Row label="共享空间地址" htmlFor="ps-hub-url">
              <input id="ps-hub-url" type="text" value={values.flowHubUrl} onChange={(e) => update("flowHubUrl", e.target.value)} placeholder="https://gitlab.example.com/group/your-flow-hub" className={inputCls} />
            </Row>
            <Row label="共享空间 Token" htmlFor="ps-hub-token" note="需要 Maintainer 及以上权限。不填的话，会改用上面「GitLab」里的 Token。">
              <SecretInput id="ps-hub-token" value={values.flowHubToken} onChange={(v) => update("flowHubToken", v)} placeholder="glpat-..." />
            </Row>
            <Row label="你的名字" htmlFor="ps-hub-author" note="上传时显示给同事">
              <input id="ps-hub-author" type="text" value={values.flowHubAuthor} onChange={(e) => update("flowHubAuthor", e.target.value)} placeholder="你的名字" className={inputCls} />
            </Row>
          </div>
        </Card>
      </div>
      {ModalPortal}
    </div>
  )
}

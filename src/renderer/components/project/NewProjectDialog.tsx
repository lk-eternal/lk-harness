import { useEffect, useMemo, useRef, useState } from "react"
import { FolderOpen, GitBranch, Loader2, Plus, X } from "lucide-react"
import { ModalShell, modalBtnGhost, modalBtnPrimary } from "../ModalShell"
import {
  PROJECT_NAME_MAX, PROJECT_REPOS_MAX, PROJECT_TEXT_MAX, repoPicksProblem, sortTemplatesForPicker,
  type ProjectCreateResult, type ProjectTemplateInfo,
} from "../../../shared/project-app-types"
import {
  parseRemoteRepoInput, picksOf, repoItemsFromOptions, upsertPickedRepo,
  type RepoPickItem,
} from "../../../shared/project-repo-picker"

interface Props {
  /** 项目建在哪个应用内对话通道下（项目归它） */
  channelId: string
  onClose: () => void
  /** 建好了（含「建好但有提示」的情况）；对话页据此切到项目会话 */
  onCreated: (result: ProjectCreateResult) => void
  /** 没有想要的项目类型：去设置里的「项目模板」自己建一个（对话页负责关掉本对话框并跳转） */
  onOpenTemplateSettings: () => void
}

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-fg outline-none transition focus:border-blue-500/70"
const smallInputCls = "rounded-md border border-line bg-surface px-2 py-1 text-[12px] text-fg outline-none transition focus:border-blue-500/70"
const dashedBtnCls = "inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-1.5 text-[12px] text-fg-muted transition hover:border-line-strong hover:bg-raised/40 hover:text-fg-2 disabled:opacity-50"

function dirLabel(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

/** 新建项目：选一种项目模板，填名称和目标；研发类模板再选代码仓库，其它类可以指定已有文件夹 */
export default function NewProjectDialog({ channelId, onClose, onCreated, onOpenTemplateSettings }: Props) {
  const [templates, setTemplates] = useState<ProjectTemplateInfo[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [templateId, setTemplateId] = useState("")
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [folder, setFolder] = useState("")
  const [repos, setRepos] = useState<RepoPickItem[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [repoNote, setRepoNote] = useState("")
  const [remoteInput, setRemoteInput] = useState("")
  const [featureBranch, setFeatureBranch] = useState("")
  const [storyUrl, setStoryUrl] = useState("")
  const [relatedDocs, setRelatedDocs] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    window.electronAPI.listProjectTemplates().then((list) => {
      if (!aliveRef.current) return
      const sorted = sortTemplatesForPicker(list)
      setTemplates(sorted)
      if (sorted[0]) setTemplateId(sorted[0].id)
    }).catch((e: unknown) => {
      if (aliveRef.current) setLoadError(e instanceof Error ? e.message : String(e))
    })
    window.electronAPI.listProjectRepoOptions().then((opts) => {
      if (!aliveRef.current) return
      // 读回来之前用户可能已经手动添加了仓库：保留那些，只补上还没有的
      setRepos((cur) => {
        const loaded = repoItemsFromOptions(opts)
        const have = new Set(cur.map((i) => i.path))
        return [...cur, ...loaded.filter((i) => !have.has(i.path))]
      })
    }).catch(() => { /* 读不到常用仓库不影响手动添加 */ }).finally(() => {
      if (aliveRef.current) setReposLoaded(true)
    })
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose() }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [busy, onClose])

  const current = useMemo(() => templates?.find((t) => t.id === templateId), [templates, templateId])
  const needsRepo = !!current?.needsRepo
  const picks = useMemo(() => picksOf(repos), [repos])
  const repoProblem = needsRepo ? repoPicksProblem(picks) : ""

  const pickTemplate = (t: ProjectTemplateInfo) => {
    if (busy) return
    setTemplateId(t.id)
    setValues({})
    setError("")
  }

  const pickFolder = async () => {
    const dir = await window.electronAPI.selectDirectory()
    if (dir) setFolder(dir)
  }

  /** 读一个本地仓库的分支提示（勾选时才读）；读不了就在这一行提示，但不挡着用户 */
  const inspectRepo = async (path: string) => {
    const r = await window.electronAPI.inspectProjectRepo(path)
    if (!aliveRef.current) return
    setRepos((cur) => cur.map((i) => {
      if (i.path !== path) return i
      if (!r.ok) return { ...i, inspected: true, note: r.error }
      return { ...i, inspected: true, note: "", branches: r.branches }
    }))
  }

  const toggleRepo = (path: string) => {
    const item = repos.find((i) => i.path === path)
    if (!item) return
    const willCheck = !item.checked
    setRepos((cur) => cur.map((i) => (i.path === path ? { ...i, checked: willCheck } : i)))
    setRepoNote("")
    if (willCheck && !item.remote && !item.inspected) void inspectRepo(path)
  }

  const setBase = (path: string, baseBranch: string) =>
    setRepos((cur) => cur.map((i) => (i.path === path ? { ...i, baseBranch } : i)))

  const addLocalRepo = async () => {
    setRepoNote("")
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    const r = await window.electronAPI.inspectProjectRepo(dir)
    if (!aliveRef.current) return
    if (!r.ok) { setRepoNote(r.error); return }
    setRepos((cur) => upsertPickedRepo(cur, { path: r.path, baseBranch: r.baseBranch, branches: r.branches }))
  }

  const addRemoteRepo = () => {
    const r = parseRemoteRepoInput(remoteInput)
    if (!r.ok) { setRepoNote(r.error); return }
    setRepoNote("")
    setRepos((cur) => upsertPickedRepo(cur, { path: r.url }))
    setRemoteInput("")
  }

  const submit = async () => {
    if (busy || !current) return
    setBusy(true)
    setError("")
    try {
      const input = needsRepo
        ? {
            name, goal, templateId: current.id, fields: values,
            repos: picks,
            ...(featureBranch.trim() ? { featureBranch: featureBranch.trim() } : {}),
            ...(storyUrl.trim() ? { storyUrl: storyUrl.trim() } : {}),
            ...(relatedDocs.trim() ? { relatedDocs: relatedDocs.trim() } : {}),
          }
        : { name, goal, templateId: current.id, fields: values, ...(folder ? { folder } : {}) }
      const r = await window.electronAPI.createProjectInApp(channelId, input)
      if (!r.ok) { setError(r.error ?? "创建失败"); return }
      onCreated(r)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  const canSubmit = !!current && name.trim().length > 0 && !repoProblem && !busy
  const footerHint = error || (needsRepo && name.trim() ? repoProblem : "")

  return (
    <ModalShell
      title="新建项目"
      footer={
        <div className="flex w-full items-center gap-3">
          <p role="alert" className={`min-w-0 flex-1 text-[12px] ${error ? "text-danger" : "text-fg-muted"}`}>{footerHint}</p>
          <button type="button" className={modalBtnGhost} onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className={modalBtnPrimary} onClick={() => void submit()} disabled={!canSubmit}>
            {busy
              ? <span className="inline-flex items-center gap-1"><Loader2 size={12} className="animate-spin" />{needsRepo ? "正在准备仓库…" : "创建中…"}</span>
              : "创建"}
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <section>
          <p className="mb-1.5 text-[12px] font-medium text-fg-3">项目类型</p>
          {loadError && <p className="text-[12px] text-danger">读取项目模板失败：{loadError}</p>}
          {!templates && !loadError && <p className="text-[12px] text-fg-muted">加载中…</p>}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {templates?.map((t) => {
              const on = t.id === templateId
              return (
                <button
                  key={t.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => pickTemplate(t)}
                  className={`rounded-lg border px-3 py-2 text-left transition ${on ? "border-blue-500/70 bg-blue-600/10" : "border-line bg-surface/60 hover:bg-raised/50"}`}
                >
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                    {t.name}
                    {t.needsRepo && <span className="inline-flex items-center gap-0.5 rounded bg-raised/80 px-1 py-px text-[10.5px] font-normal text-fg-muted"><GitBranch size={10} />接代码仓库</span>}
                  </span>
                </button>
              )
            })}
          </div>
          {/* 卡片只放名称，选中那个的说明放在下面：模板多时不把后面要填的内容挤出屏幕 */}
          {current && (
            <div className="mt-1.5 space-y-0.5 text-[11.5px] leading-snug text-fg-muted">
              {current.description && <p>{current.description}</p>}
              {current.steps.length > 0 && <p>项目里会有这些快捷操作：{current.steps.map((s) => s.label).join("、")}。也可以直接在对话里告诉 AI 想做什么。</p>}
            </div>
          )}
          <p className="mt-2 text-[11.5px] text-fg-muted">
            没有想要的类型？
            <button
              type="button"
              disabled={busy}
              onClick={onOpenTemplateSettings}
              className="ml-0.5 text-accent underline-offset-2 transition hover:underline disabled:opacity-50 disabled:no-underline"
            >去「项目模板」新建一个</button>
          </p>
        </section>

        <section className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-fg-3">项目名称</span>
            <input
              value={name}
              maxLength={PROJECT_NAME_MAX}
              autoFocus
              placeholder={needsRepo ? "比如：订单页改版" : "比如：Q4 竞品调研"}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && canSubmit) void submit() }}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-medium text-fg-3">想做成什么 <span className="font-normal text-fg-faint">（可选）</span></span>
            <textarea
              value={goal}
              maxLength={PROJECT_TEXT_MAX}
              rows={2}
              placeholder="一两句话说清目标，AI 会据此推进"
              onChange={(e) => setGoal(e.target.value)}
              className={`${inputCls} resize-none`}
            />
          </label>
          {current?.fields.map((f) => (
            <label key={f.label} className="block">
              <span className="mb-1 block text-[12px] font-medium text-fg-3">
                {f.label}{f.required ? <span className="text-danger"> *</span> : <span className="font-normal text-fg-faint"> （可选）</span>}
              </span>
              {f.multiline ? (
                <textarea
                  value={values[f.label] ?? ""}
                  maxLength={PROJECT_TEXT_MAX}
                  rows={2}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.label]: e.target.value }))}
                  className={`${inputCls} resize-none`}
                />
              ) : (
                <input
                  value={values[f.label] ?? ""}
                  maxLength={PROJECT_TEXT_MAX}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues((v) => ({ ...v, [f.label]: e.target.value }))}
                  className={inputCls}
                />
              )}
            </label>
          ))}
        </section>

        {needsRepo ? (
          <>
            <section>
              <p className="mb-1.5 text-[12px] font-medium text-fg-3">代码仓库 <span className="font-normal text-fg-faint">（最多 {PROJECT_REPOS_MAX} 个）</span></p>
              {repos.length === 0 && (
                <p className="mb-1.5 text-[12px] text-fg-muted">{reposLoaded ? "还没有常用仓库，添加一个本地仓库或远程地址吧。" : "加载中…"}</p>
              )}
              <ul className="space-y-1.5">
                {repos.map((r, idx) => (
                  <li key={r.path} className={`rounded-lg border px-3 py-2 ${r.checked ? "border-blue-500/50 bg-blue-600/5" : "border-line bg-surface/60"}`}>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={r.checked}
                        disabled={busy}
                        onChange={() => toggleRepo(r.path)}
                        aria-label={`选用 ${r.name}`}
                        className="h-3.5 w-3.5 shrink-0 accent-blue-500"
                      />
                      <button type="button" disabled={busy} onClick={() => toggleRepo(r.path)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-[13px] font-medium text-fg">{r.name}</span>
                        <span className="block truncate text-[11px] text-fg-faint" title={r.path}>{r.path}</span>
                      </button>
                      {r.checked && (
                        <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-fg-muted">
                          基线分支
                          <input
                            value={r.baseBranch}
                            list={`repo-branches-${idx}`}
                            disabled={busy}
                            onChange={(e) => setBase(r.path, e.target.value)}
                            className={`${smallInputCls} w-32`}
                          />
                          <datalist id={`repo-branches-${idx}`}>{r.branches.map((b) => <option key={b} value={b} />)}</datalist>
                        </label>
                      )}
                    </div>
                    {r.note && <p className="mt-1 text-[11.5px] text-danger">{r.note}</p>}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" disabled={busy} onClick={() => void addLocalRepo()} className={dashedBtnCls}>
                  <FolderOpen size={13} />添加本地仓库
                </button>
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <input
                    value={remoteInput}
                    disabled={busy}
                    placeholder="或粘贴远程仓库地址（https://… 或 git@…）"
                    onChange={(e) => { setRemoteInput(e.target.value); if (repoNote) setRepoNote("") }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addRemoteRepo() } }}
                    className={`${smallInputCls} min-w-0 flex-1`}
                  />
                  <button type="button" disabled={busy || !remoteInput.trim()} onClick={addRemoteRepo} className={dashedBtnCls}><Plus size={13} />添加</button>
                </div>
              </div>
              {repoNote && <p role="alert" className="mt-1.5 text-[12px] text-danger">{repoNote}</p>}
              <p className="mt-1.5 text-[11.5px] leading-snug text-fg-muted">
                AI 会在每个仓库的独立副本里改代码，你自己的仓库不会被动。勾过的仓库下次会自动记在这里。
              </p>
            </section>

            <section className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-fg-3">feature 分支 <span className="font-normal text-fg-faint">（可选）</span></span>
                <input
                  value={featureBranch}
                  maxLength={PROJECT_NAME_MAX * 2}
                  placeholder="不填会自动生成：feature/日期-项目名"
                  onChange={(e) => setFeatureBranch(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-fg-3">项目链接 <span className="font-normal text-fg-faint">（可选：需求、任务单、设计稿…）</span></span>
                <input
                  value={storyUrl}
                  maxLength={PROJECT_TEXT_MAX}
                  onChange={(e) => setStoryUrl(e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[12px] font-medium text-fg-3">相关文档 <span className="font-normal text-fg-faint">（可选）</span></span>
                <textarea
                  value={relatedDocs}
                  maxLength={PROJECT_TEXT_MAX}
                  rows={2}
                  placeholder="技术方案、接口文档的链接或说明"
                  onChange={(e) => setRelatedDocs(e.target.value)}
                  className={`${inputCls} resize-none`}
                />
              </label>
            </section>
          </>
        ) : (
          <section>
            <p className="mb-1.5 text-[12px] font-medium text-fg-3">项目文件夹 <span className="font-normal text-fg-faint">（可选）</span></p>
            {folder ? (
              <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5">
                <FolderOpen size={14} className="shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2" title={folder}>{dirLabel(folder)}</span>
                <button type="button" onClick={() => setFolder("")} title="不用这个文件夹" className="shrink-0 rounded p-0.5 text-fg-muted transition hover:text-danger"><X size={13} /></button>
              </div>
            ) : (
              <button type="button" onClick={() => void pickFolder()} className={dashedBtnCls}><FolderOpen size={13} />使用已有文件夹</button>
            )}
            <p className="mt-1.5 text-[11.5px] leading-snug text-fg-muted">
              {folder
                ? "AI 会在这个文件夹里工作，成果放在其中的 .lk-harness 文件夹里；你原有的文件，除非你明确要求，AI 不会去改。删除项目时这个文件夹不会被删。"
                : "不选的话，应用会自动给项目建一个文件夹，成果都放在里面；删除项目时会一起移到回收站。"}
            </p>
          </section>
        )}
      </div>
    </ModalShell>
  )
}

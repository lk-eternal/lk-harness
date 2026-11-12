import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Archive, ArchiveRestore, Download, Eye, FileText, FolderKanban, GitBranch, Info, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { previewTypeOf } from "../shared/preview-kinds"
import {
  PROJECT_NAME_MAX, PROJECT_REPOS_MAX, PROJECT_TEXT_MAX, projectDeleteConfirmText, repoPicksProblem, sortTemplatesForPicker,
  type ProjectCreateResult, type ProjectTemplateInfo, type ProjectView,
} from "../shared/project-app-types"
import {
  parseRemoteRepoInput, picksOf, repoItemsFromOptions, upsertPickedRepo,
  type RepoPickItem,
} from "../shared/project-repo-picker"
import { usePreview } from "../renderer/components/preview/PreviewContext"
import { formatTimeAgo } from "../renderer/time-ago"
import {
  createMobileProject, deleteMobileProject, fetchMobileProjectRepos, fetchMobileProjectTemplates, fetchMobileProjectView,
  runMobileProjectStep, setMobileProjectArchived, syncMobileProjectSteps,
} from "./api"
import { useBackToClose } from "./back-stack"
import { MobilePreviewProvider } from "./MobilePreview"
import { projectArtifactDownloadUrl } from "./project-download"
import { useFileDownload } from "./use-file-download"
import { useSheetDrag } from "./useSheetDrag"

const inputCls = "w-full rounded-xl border border-line bg-page px-3 py-2 text-[14px] text-fg focus:border-blue-500 focus:outline-none"

// ── 新建项目 ───────────────────────────────────────────────────────────────

/**
 * 手机上新建项目：选一种项目模板，填名称和目标；研发类模板再勾代码仓库（从电脑上记过的常用仓库里选，或填远程地址）。
 * 项目文件夹由电脑端自己管（手机上选不了电脑里的文件夹），要用已有文件夹请在电脑端建。
 */
export function NewProjectSheet({ open, onClose, baseUrl, token, channelId, onCreated }: {
  open: boolean
  onClose: () => void
  baseUrl: string
  token: string
  /** 项目建在哪个应用内对话通道下（项目归它） */
  channelId: string
  /** 建好了（含「建好但有提示」）；sessionKey 在建好时抽屉已经关了的情况下为空，只需要刷新列表 */
  onCreated: (result: ProjectCreateResult) => void
}) {
  const [templates, setTemplates] = useState<ProjectTemplateInfo[] | null>(null)
  const [loadError, setLoadError] = useState("")
  const [templateId, setTemplateId] = useState("")
  const [name, setName] = useState("")
  const [goal, setGoal] = useState("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [repos, setRepos] = useState<RepoPickItem[]>([])
  const [reposLoaded, setReposLoaded] = useState(false)
  const [repoNote, setRepoNote] = useState("")
  const [remoteInput, setRemoteInput] = useState("")
  const [featureBranch, setFeatureBranch] = useState("")
  const [storyUrl, setStoryUrl] = useState("")
  const [relatedDocs, setRelatedDocs] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const openRef = useRef(open)
  openRef.current = open

  useEffect(() => {
    if (!open) return
    let alive = true
    setTemplates(null)
    setLoadError("")
    setTemplateId("")
    setName("")
    setGoal("")
    setValues({})
    setRepos([])
    setReposLoaded(false)
    setRepoNote("")
    setRemoteInput("")
    setFeatureBranch("")
    setStoryUrl("")
    setRelatedDocs("")
    setError("")
    setBusy(false)
    fetchMobileProjectTemplates(baseUrl, token).then((r) => {
      if (!alive) return
      if (!r.ok || !r.templates) { setLoadError(r.error ?? "读取模板失败"); return }
      const sorted = sortTemplatesForPicker(r.templates)
      setTemplates(sorted)
      if (sorted[0]) setTemplateId(sorted[0].id)
    }).catch((e: unknown) => {
      if (alive) setLoadError(e instanceof Error ? e.message : String(e))
    })
    fetchMobileProjectRepos(baseUrl, token).then((r) => {
      if (!alive) return
      if (r.ok && r.repos) {
        const loaded = repoItemsFromOptions(r.repos)
        setRepos((cur) => {
          const have = new Set(cur.map((i) => i.path))
          return [...cur, ...loaded.filter((i) => !have.has(i.path))]
        })
      }
    }).catch(() => { /* 读不到常用仓库不影响填远程地址 */ }).finally(() => {
      if (alive) setReposLoaded(true)
    })
    return () => { alive = false }
  }, [open, baseUrl, token])

  useBackToClose(open, onClose)
  const { panelRef, grip } = useSheetDrag(onClose)
  if (!open) return null

  const current = templates?.find((t) => t.id === templateId)
  const needsRepo = !!current?.needsRepo
  const picks = picksOf(repos)
  const repoProblem = needsRepo ? repoPicksProblem(picks) : ""
  const canSubmit = !!current && name.trim().length > 0 && !repoProblem && !busy
  const footerHint = error || (needsRepo && name.trim() ? repoProblem : "")

  const pickTemplate = (t: ProjectTemplateInfo) => {
    if (busy) return
    setTemplateId(t.id)
    setValues({})
    setError("")
  }

  const toggleRepo = (path: string) => {
    setRepoNote("")
    setRepos((cur) => cur.map((i) => (i.path === path ? { ...i, checked: !i.checked } : i)))
  }
  const setBase = (path: string, baseBranch: string) =>
    setRepos((cur) => cur.map((i) => (i.path === path ? { ...i, baseBranch } : i)))
  const addRemoteRepo = () => {
    const r = parseRemoteRepoInput(remoteInput)
    if (!r.ok) { setRepoNote(r.error); return }
    setRepoNote("")
    setRepos((cur) => upsertPickedRepo(cur, { path: r.url }))
    setRemoteInput("")
  }

  const submit = async () => {
    if (!current || !canSubmit) return
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
        : { name, goal, templateId: current.id, fields: values }
      const r = await createMobileProject(baseUrl, token, channelId, input)
      if (!r.ok) { setError(r.error ?? "创建失败"); return }
      // 建的过程中用户把弹层关了：项目已经建好，只刷新列表，不替他切走
      onCreated(openRef.current ? r : { ...r, sessionKey: undefined })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div onClick={onClose} className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div ref={panelRef} className="relative z-10 flex max-h-[88vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        {grip}
        <div className="flex items-center justify-between px-4 pb-1 pt-1">
          <div className="flex items-center gap-2">
            <FolderKanban size={16} className="text-accent" />
            <span className="text-sm font-semibold text-fg">新建项目</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded-lg p-1 text-fg-muted"><X size={16} /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-3 pt-2">
          <section>
            <p className="mb-1.5 text-[12px] font-medium text-fg-3">项目类型</p>
            {loadError && <p role="alert" className="text-[12px] text-danger">读取项目模板失败：{loadError}</p>}
            {!templates && !loadError && (
              <p className="flex items-center gap-1.5 text-[12px] text-fg-muted"><Loader2 size={13} className="animate-spin text-accent" />加载中…</p>
            )}
            <div className="grid grid-cols-2 gap-1.5">
              {templates?.map((t) => {
                const on = t.id === templateId
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => pickTemplate(t)}
                    className={`block w-full rounded-xl border px-3 py-2 text-left transition active:scale-[0.99] ${on ? "border-blue-500/60 bg-blue-600/15" : "border-line-subtle bg-page/60"}`}
                  >
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] font-medium text-fg">
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
          </section>

          <section className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-medium text-fg-3">项目名称</span>
              <input
                value={name}
                maxLength={PROJECT_NAME_MAX}
                placeholder={needsRepo ? "比如：订单页改版" : "比如：Q4 竞品调研"}
                onChange={(e) => setName(e.target.value)}
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
                  <p className="mb-1.5 text-[12px] text-fg-muted">{reposLoaded ? "电脑上还没有常用仓库，先填一个远程仓库地址吧。" : "加载中…"}</p>
                )}
                <ul className="space-y-1.5">
                  {repos.map((r) => (
                    <li key={r.path} className={`rounded-xl border px-3 py-2 ${r.checked ? "border-blue-500/60 bg-blue-600/10" : "border-line-subtle bg-page/60"}`}>
                      <button type="button" disabled={busy} onClick={() => toggleRepo(r.path)} aria-pressed={r.checked} className="flex w-full items-center gap-2 text-left">
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[11px] ${r.checked ? "border-blue-500 bg-blue-600 text-white" : "border-line"}`}>{r.checked ? "✓" : ""}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-fg">{r.name}</span>
                          <span className="block truncate text-[11px] text-fg-faint">{r.path}</span>
                        </span>
                      </button>
                      {r.checked && (
                        <label className="mt-2 flex items-center gap-2 text-[12px] text-fg-muted">
                          基线分支
                          <input
                            value={r.baseBranch}
                            disabled={busy}
                            autoCapitalize="none"
                            autoCorrect="off"
                            onChange={(e) => setBase(r.path, e.target.value)}
                            className="min-w-0 flex-1 rounded-lg border border-line bg-page px-2 py-1 text-[13px] text-fg focus:border-blue-500 focus:outline-none"
                          />
                        </label>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={remoteInput}
                    disabled={busy}
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="远程仓库地址（https://… 或 git@…）"
                    onChange={(e) => { setRemoteInput(e.target.value); if (repoNote) setRepoNote("") }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addRemoteRepo() } }}
                    className="min-w-0 flex-1 rounded-xl border border-line bg-page px-3 py-2 text-[13px] text-fg focus:border-blue-500 focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy || !remoteInput.trim()}
                    onClick={addRemoteRepo}
                    className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-line px-3 py-2 text-[12px] text-fg-2 active:scale-95 disabled:opacity-40"
                  ><Plus size={13} />添加</button>
                </div>
                {repoNote && <p role="alert" className="mt-1.5 text-[12px] text-danger">{repoNote}</p>}
                <p className="mt-1.5 text-[11.5px] leading-snug text-fg-muted">
                  AI 会在电脑上每个仓库的独立副本里改代码，你自己的仓库不会被动。手机上选不了电脑里的文件夹，要新加本地仓库请在电脑端建一次项目，之后这里就能勾了。
                </p>
              </section>

              <section className="space-y-3">
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-fg-3">feature 分支 <span className="font-normal text-fg-faint">（可选）</span></span>
                  <input
                    value={featureBranch}
                    maxLength={PROJECT_NAME_MAX * 2}
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder="不填会自动生成：feature/日期-项目名"
                    onChange={(e) => setFeatureBranch(e.target.value)}
                    className={inputCls}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[12px] font-medium text-fg-3">项目链接 <span className="font-normal text-fg-faint">（可选：需求、任务单、设计稿…）</span></span>
                  <input value={storyUrl} maxLength={PROJECT_TEXT_MAX} onChange={(e) => setStoryUrl(e.target.value)} className={inputCls} />
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
            <p className="text-[11.5px] leading-snug text-fg-muted">
              电脑上会自动给项目建一个文件夹，成果都放在里面；删除项目时会一起移到回收站。想用电脑上已有的文件夹，请在电脑端建项目。
            </p>
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line-subtle px-4 py-3">
          <p role="alert" className={`min-w-0 flex-1 text-[12px] ${error ? "text-danger" : "text-fg-muted"}`}>{footerHint}</p>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-blue-600 px-5 py-2 text-[13px] font-medium text-white transition active:scale-95 disabled:opacity-40"
          >
            {busy ? <><Loader2 size={13} className="animate-spin" />{needsRepo ? "正在准备仓库…" : "创建中…"}</> : "创建"}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 项目栏（输入框上方）和项目信息 ──────────────────────────────────────────

const isHttpUrl = (s: string) => /^https?:\/\//i.test(s.trim())
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-4 py-2.5">
      <p className="mb-1 text-[11.5px] font-medium text-fg-muted">{title}</p>
      {children}
    </div>
  )
}

function ProjectInfoSheet({ open, onClose, view, baseUrl, token, sessionKey, busy, onSync, onArchive, onDelete }: {
  open: boolean
  onClose: () => void
  view: ProjectView
  baseUrl: string
  token: string
  sessionKey: string
  busy: "sync" | "delete" | "archive" | null
  onSync: () => void
  /** 归档 / 取消归档（看 view.archived） */
  onArchive: () => void
  onDelete: () => void
}) {
  useBackToClose(open, onClose)
  const { panelRef, grip } = useSheetDrag(onClose)
  const preview = usePreview()
  const { downloading, error: downloadError, start } = useFileDownload()
  if (!open) return null

  const art = view.artifact
  // 手机上 PDF 显示不了（Android WebView 不能内嵌 PDF），只给下载
  const kind = art ? previewTypeOf(art.name).kind : "unsupported"
  const canPreview = !!art && art.exists && preview.available && kind !== "unsupported" && kind !== "pdf"

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end">
      <div onClick={onClose} className="fixed inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div ref={panelRef} className="relative z-10 flex max-h-[80vh] flex-col rounded-t-3xl border-t border-line bg-surface pb-safe shadow-2xl">
        {grip}
        <div className="flex items-start justify-between gap-2 px-4 pb-2 pt-1">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-fg">{view.name}</span>
              {view.archived && (
                <span className="shrink-0 rounded bg-raised px-1.5 text-[10.5px] leading-4 text-fg-muted">已归档</span>
              )}
            </div>
            <p className="mt-0.5 text-[11.5px] text-fg-muted">
              {view.templateNames.join(" + ")}
              {view.featureBranch ? ` · 分支 ${view.featureBranch}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭" className="shrink-0 rounded-lg p-1 text-fg-muted"><X size={16} /></button>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-line-subtle overflow-y-auto border-t border-line-subtle">
          {view.goal && (
            <Section title="目标"><p className="whitespace-pre-wrap break-words text-[13px] text-fg-2">{view.goal}</p></Section>
          )}

          {view.info.length > 0 && (
            <Section title="项目信息">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
                {view.info.map((i) => (
                  <div key={i.key} className="contents">
                    <dt className="text-fg-muted">{i.key}</dt>
                    <dd className="whitespace-pre-wrap break-words text-fg-2">{i.value}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          {(view.storyUrl || view.relatedDocs) && (
            <Section title="链接和资料">
              {view.storyUrl && (isHttpUrl(view.storyUrl)
                ? <a href={view.storyUrl} target="_blank" rel="noopener noreferrer" className="block break-all text-[13px] text-accent">{view.storyUrl}</a>
                : <p className="break-all text-[13px] text-fg-2">{view.storyUrl}</p>)}
              {view.relatedDocs && <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] text-fg-2">{view.relatedDocs}</p>}
            </Section>
          )}

          <Section title="最近成果">
            {art ? (
              <>
                <div className="flex items-center gap-2.5">
                  <FileText size={16} className="shrink-0 text-fg-faint" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-fg-2">{art.name}</p>
                    <p className="truncate text-[11.5px] text-fg-muted">
                      {art.exists ? (art.summary ?? "") : "文件已经不在了"}
                      {art.at ? `${art.exists && art.summary ? " · " : ""}${formatTimeAgo(art.at, Date.now())}` : ""}
                    </p>
                  </div>
                  {canPreview && (
                    <button
                      type="button"
                      onClick={() => preview.openFile({ path: art.path, name: art.name })}
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white transition active:scale-95"
                    ><Eye size={13} />预览</button>
                  )}
                  {art.exists && (
                    <button
                      type="button"
                      disabled={downloading}
                      onClick={() => void start(() => projectArtifactDownloadUrl(baseUrl, token, sessionKey, art.path), art.name)}
                      className={`inline-flex shrink-0 items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition active:scale-95 disabled:opacity-60 ${canPreview ? "border border-line text-fg-2" : "bg-blue-600 text-white"}`}
                    >{downloading ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}下载</button>
                  )}
                </div>
                {downloadError && <p className="mt-1.5 text-[11px] text-amber-400">{downloadError}</p>}
              </>
            ) : (
              <p className="text-[13px] text-fg-faint">还没有。AI 做完一步，成果会记在这里。</p>
            )}
          </Section>

          <Section title={view.externalDir ? "项目文件夹（你选的，在电脑上）" : "项目文件夹（在电脑上）"}>
            <p className="break-all font-mono text-[11px] text-fg-muted">{view.dir}</p>
          </Section>

          {view.ownedHere && (
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              {view.canSyncSteps && (
                <button
                  type="button"
                  onClick={onSync}
                  disabled={!!busy}
                  className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-fg-2 transition active:bg-raised disabled:opacity-50"
                >{busy === "sync" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}同步最新模板</button>
              )}
              <button
                type="button"
                onClick={onArchive}
                disabled={!!busy}
                className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-xs text-fg-2 transition active:bg-raised disabled:opacity-50"
              >{busy === "archive" ? <Loader2 size={12} className="animate-spin" /> : view.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}{view.archived ? "取消归档" : "归档项目"}</button>
              <button
                type="button"
                onClick={onDelete}
                disabled={!!busy}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-danger transition active:bg-raised disabled:opacity-50"
              >{busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}删除项目</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface BarProps {
  baseUrl: string
  token: string
  /** 当前会话所在的应用内通道：项目归不归它，决定能不能点步骤、删除 */
  channelId: string
  projectId: string
  /** 项目会话键：预览、下载成果时用它校验权限 */
  sessionKey: string
  /** 会话进程是否在跑；跑完后项目信息（成果等）可能变了，重新读一次 */
  running: boolean
  confirm: (title: string, message: string, ok: string) => Promise<boolean>
  /** 点步骤成功：稍后刷新会话状态 */
  onStarted: () => void
  /** 项目已删除 */
  onDeleted: () => void
  /** 归档 / 取消归档成功：会话列表据此把它挪进（出）「已归档」分组 */
  onArchiveChanged: (archived: boolean) => void
  onError: (message: string) => void
}

function ProjectBarBody({ baseUrl, token, channelId, projectId, sessionKey, running, confirm, onStarted, onDeleted, onArchiveChanged, onError }: BarProps) {
  const [view, setView] = useState<ProjectView | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [starting, setStarting] = useState<string | null>(null)
  const [busy, setBusy] = useState<"sync" | "delete" | "archive" | null>(null)
  const seqRef = useRef(0)

  const reload = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const r = await fetchMobileProjectView(baseUrl, token, channelId, projectId)
      if (seq === seqRef.current && r.ok && r.view) setView(r.view)
    } catch { /* 读不到就保持上一次的内容 */ }
  }, [baseUrl, token, channelId, projectId])

  // 进入项目、会话跑完（running 翻转）、打开信息面板时重读
  useEffect(() => { void reload() }, [reload, running, infoOpen])

  const closeInfo = useCallback(() => setInfoOpen(false), [])

  if (!view) return null

  const runStep = async (nodeId: string) => {
    if (starting) return
    setStarting(nodeId)
    try {
      const r = await runMobileProjectStep(baseUrl, token, channelId, projectId, nodeId)
      if (!r.ok) onError(r.error ?? "启动失败")
      else onStarted()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(null)
    }
  }

  const syncSteps = async () => {
    if (busy) return
    setBusy("sync")
    try {
      const r = await syncMobileProjectSteps(baseUrl, token, projectId)
      if (!r.ok) onError(r.error ?? "同步失败")
      await reload()
    } finally {
      setBusy(null)
    }
  }

  /** 归档 / 取消归档：做完了的项目收起来，不用确认（随时能取消）；会话和成果都还在 */
  const toggleArchive = async () => {
    if (busy) return
    const next = !view.archived
    setBusy("archive")
    try {
      const r = await setMobileProjectArchived(baseUrl, token, channelId, projectId, next)
      if (!r.ok) { onError(r.error ?? (next ? "归档失败" : "取消归档失败")); return }
      setInfoOpen(false)
      await reload()
      onArchiveChanged(next)
    } finally {
      setBusy(null)
    }
  }

  const removeProject = async () => {
    if (busy) return
    if (!await confirm("删除项目", projectDeleteConfirmText(view, "电脑的回收站"), "删除")) return
    setBusy("delete")
    try {
      const r = await deleteMobileProject(baseUrl, token, channelId, projectId)
      if (!r.ok) { onError(r.error ?? "删除失败"); return }
      setInfoOpen(false)
      onDeleted()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-1.5 rounded-xl border border-line bg-page/70 px-2 py-1">
        <FolderKanban size={14} className="shrink-0 text-accent" />
        {view.archived && <span className="shrink-0 rounded bg-raised px-1.5 text-[11px] leading-5 text-fg-muted">已归档</span>}
        {view.ownedHere ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {view.steps.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => void runStep(s.id)}
                disabled={!!starting}
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] text-fg-2 transition active:scale-95 disabled:opacity-60"
              >
                {starting === s.id && <Loader2 size={11} className="animate-spin" />}{s.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="min-w-0 flex-1 py-1 text-[11.5px] leading-snug text-fg-muted">这个项目归其它通道管（比如飞书），这里只能聊天和查看；快捷操作请到它所在的聊天里点。</span>
        )}
        <button
          type="button"
          onClick={() => setInfoOpen(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1.5 text-[12px] text-fg-muted transition active:bg-raised"
        ><Info size={13} />项目信息</button>
      </div>
      {/* 挂到 body：底部输入栏的 backdrop-filter 会把内部 fixed 元素的参照系缩成输入栏大小，遮罩盖不住整屏 */}
      {createPortal(
        <ProjectInfoSheet
          open={infoOpen}
          onClose={closeInfo}
          view={view}
          baseUrl={baseUrl}
          token={token}
          sessionKey={sessionKey}
          busy={busy}
          onSync={() => void syncSteps()}
          onArchive={() => void toggleArchive()}
          onDelete={() => void removeProject()}
        />,
        document.body,
      )}
    </>
  )
}

/**
 * 项目会话输入框上方的项目栏：这个项目有哪些快捷操作（点一下就让 AI 做这件事，和直接在对话里说效果一样），以及项目信息（目标、成果、文件夹）和删除项目。
 * 归别的通道管的项目（飞书里建的）只读：点快捷操作会把它的会话绑定抢过来，所以不给点。
 * 自带一层文件预览（成果的「预览」），和聊天里的文件卡走同一套页面。
 */
export default function MobileProjectBar(props: BarProps) {
  return (
    <MobilePreviewProvider baseUrl={props.baseUrl} token={props.token} sessionKey={props.sessionKey}>
      <ProjectBarBody {...props} />
    </MobilePreviewProvider>
  )
}

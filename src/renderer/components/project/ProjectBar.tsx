import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Archive, ArchiveRestore, FileText, FolderKanban, FolderOpen, Info, Loader2, Trash2 } from "lucide-react"
import { parentPath } from "../../../shared/preview-kinds"
import { projectDeleteConfirmText, type ProjectView } from "../../../shared/project-app-types"
import { splitTextLinks } from "../../../shared/text-links"
import useOutsideClose from "../../hooks/useOutsideClose"
import { formatTimeAgo } from "../../time-ago"
import { SafeLink } from "../chat/Markdown"
import { usePreview } from "../preview/PreviewContext"

interface Props {
  /** 当前对话所在的应用内通道：项目归不归它，决定能不能点步骤、删除 */
  channelId: string
  projectId: string
  /** 会话进程是否在跑；跑完后项目信息（成果、项目信息）可能变了，重新读一次 */
  running: boolean
  /** 值一变就重读一次：项目在别处改了（比如在会话标题上改了项目名），这里显示的内容要跟着变 */
  reloadToken?: number
  /** 删项目前确认（沿用对话页的确认弹窗） */
  confirm: (title: string, message: string, ok: string) => Promise<boolean>
  /** 点步骤成功：对话页稍后刷新会话状态 */
  onStarted: () => void
  /** 项目已删除 */
  onDeleted: () => void
  /** 项目归档 / 取消归档成功：对话页据此把它挪进（出）「已归档」分组 */
  onArchiveChanged: (archived: boolean) => void
  onError: (message: string) => void
}

/** 自由文字里的网址变成可点的链接；点法和对话里的链接一致（按「链接打开方式」设置，按住 Ctrl/⌘ 反过来） */
function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitTextLinks(text).map((p, i) => (p.kind === "link"
        ? <SafeLink key={i} href={p.url} className="text-link hover:underline">{p.url}</SafeLink>
        : p.text))}
    </>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="px-3 py-2">
      <p className="mb-1 text-[11.5px] font-medium text-fg-muted">{title}</p>
      {children}
    </div>
  )
}

/**
 * 项目会话输入框上方的项目栏：这个项目有哪些快捷操作（点一下就让 AI 做这件事，和直接在对话里说效果一样），
 * 以及项目信息（目标、项目信息、最近成果、文件夹）、归档和删除项目。
 * 归别的通道管的项目（飞书里建的）只读：点快捷操作会把它的会话绑定抢过来，所以不给点。
 */
export default function ProjectBar({ channelId, projectId, running, reloadToken, confirm, onStarted, onDeleted, onArchiveChanged, onError }: Props) {
  const preview = usePreview()
  const [view, setView] = useState<ProjectView | null>(null)
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState<string | null>(null)
  const [busy, setBusy] = useState<"delete" | "archive" | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const seqRef = useRef(0)

  const reload = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const v = await window.electronAPI.getProjectView(projectId, channelId)
      if (seq === seqRef.current) setView(v)
    } catch { /* 读不到就保持上一次的内容 */ }
  }, [projectId, channelId])

  // 进入项目、会话跑完（running 翻转）、打开信息面板、项目在别处改了（reloadToken 变）时重读
  useEffect(() => { void reload() }, [reload, running, open, reloadToken])

  const close = useCallback(() => setOpen(false), [])
  useOutsideClose(open, rootRef, close)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open])

  if (!view) return null

  const runStep = async (nodeId: string) => {
    if (starting) return
    setStarting(nodeId)
    try {
      const r = await window.electronAPI.runProjectStep(channelId, projectId, nodeId)
      if (!r.ok) onError(r.error ?? "启动失败")
      else onStarted()
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(null)
    }
  }

  /** 归档 / 取消归档：做完了的项目收起来，不用确认（随时能取消）；会话和成果都还在 */
  const toggleArchive = async () => {
    if (busy) return
    const next = !view.archived
    setBusy("archive")
    try {
      const r = await window.electronAPI.setProjectArchived(projectId, next, channelId)
      if (!r.ok) { onError(r.error ?? (next ? "归档失败" : "取消归档失败")); return }
      setOpen(false)
      await reload()
      onArchiveChanged(next)
    } finally {
      setBusy(null)
    }
  }

  const removeProject = async () => {
    if (busy) return
    if (!await confirm("删除项目", projectDeleteConfirmText(view), "删除")) return
    setBusy("delete")
    try {
      const r = await window.electronAPI.deleteProject(projectId, channelId)
      if (!r.ok) { onError(r.error ?? "删除失败"); return }
      setOpen(false)
      onDeleted()
    } finally {
      setBusy(null)
    }
  }

  const art = view.artifact
  const artDir = art ? parentPath(art.path) : undefined

  return (
    <div ref={rootRef} className="relative mb-2">
      {open && (
        <div className="absolute bottom-full left-0 right-0 z-20 mb-1.5 max-h-[60vh] divide-y divide-line-subtle overflow-y-auto rounded-xl border border-line bg-page shadow-lg">
          <div className="px-3 pb-2 pt-2.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{view.name}</span>
              {view.archived && (
                <span className="shrink-0 rounded bg-raised px-1.5 text-[10.5px] leading-4 text-fg-muted">已归档</span>
              )}
            </div>
            <p className="mt-0.5 text-[11.5px] text-fg-muted">
              {view.templateNames.join(" + ")}
            </p>
          </div>

          {view.goal && (
            <Section title="目标"><p className="whitespace-pre-wrap text-[12.5px] text-fg-2"><LinkedText text={view.goal} /></p></Section>
          )}

          {view.info.length > 0 && (
            <Section title="项目信息">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
                {view.info.map((i) => (
                  <div key={i.key} className="contents">
                    <dt className="text-fg-muted">{i.key}</dt>
                    <dd className="whitespace-pre-wrap break-words text-fg-2"><LinkedText text={i.value} /></dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}

          {(view.storyUrl || view.relatedDocs) && (
            <Section title="链接和资料">
              {view.storyUrl && <p className="truncate text-[12.5px] text-fg-2" title={view.storyUrl}><LinkedText text={view.storyUrl} /></p>}
              {view.relatedDocs && <p className="mt-0.5 whitespace-pre-wrap break-words text-[12.5px] text-fg-2"><LinkedText text={view.relatedDocs} /></p>}
            </Section>
          )}

          <Section title="最近成果">
            {art ? (
              <div className="flex items-center gap-2">
                <FileText size={14} className="shrink-0 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] text-fg-2" title={art.path}>{art.name}</p>
                  <p className="truncate text-[11.5px] text-fg-muted">
                    {art.exists ? (art.summary ?? "") : "文件已经不在了"}
                    {art.at ? `${art.exists && art.summary ? " · " : ""}${formatTimeAgo(art.at, Date.now())}` : ""}
                  </p>
                </div>
                {art.exists && (
                  <>
                    <button type="button" onClick={() => preview.openFile({ path: art.path, name: art.name })} disabled={!preview.available} className="shrink-0 rounded border border-focus/60 px-2 py-0.5 text-[11.5px] text-accent-soft transition hover:bg-primary/10 disabled:opacity-40">预览</button>
                    {artDir && (
                      <button type="button" onClick={() => preview.openDir({ path: artDir })} disabled={!preview.available} className="shrink-0 rounded border border-focus/60 px-2 py-0.5 text-[11.5px] text-accent-soft transition hover:bg-primary/10 disabled:opacity-40">预览所在文件夹</button>
                    )}
                    <button type="button" onClick={() => void window.electronAPI.appChatShowInFolder(art.path)} className="shrink-0 rounded border border-line px-2 py-0.5 text-[11.5px] text-fg-3 transition hover:bg-raised/50">所在位置</button>
                  </>
                )}
              </div>
            ) : (
              <p className="text-[12.5px] text-fg-faint">还没有。AI 做完一步，成果会记在这里。</p>
            )}
          </Section>

          <Section title={view.externalDir ? "项目文件夹（你选的）" : "项目文件夹"}>
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[12.5px] text-fg-2" title={view.dir}>{view.dir}</p>
              <button type="button" onClick={() => preview.openDir({ path: view.dir })} disabled={!preview.available} className="shrink-0 rounded border border-focus/60 px-2 py-0.5 text-[11.5px] text-accent-soft transition hover:bg-primary/10 disabled:opacity-40">预览</button>
              <button type="button" onClick={() => void window.electronAPI.appChatShowInFolder(view.dir)} className="inline-flex shrink-0 items-center gap-1 rounded border border-line px-2 py-0.5 text-[11.5px] text-fg-3 transition hover:bg-raised/50"><FolderOpen size={12} />打开</button>
            </div>
          </Section>

          {view.ownedHere && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => void toggleArchive()}
                disabled={!!busy}
                title={view.archived ? "放回会话列表" : "做完了就归档：收进会话列表最下面的「已归档」，会话和成果都留着，随时可以取消"}
                className="ml-auto inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-[12px] text-fg-3 transition hover:bg-raised/50 disabled:opacity-50"
              >{busy === "archive" ? <Loader2 size={12} className="animate-spin" /> : view.archived ? <ArchiveRestore size={12} /> : <Archive size={12} />}{view.archived ? "取消归档" : "归档项目"}</button>
              <button
                type="button"
                onClick={() => void removeProject()}
                disabled={!!busy}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] text-fg-muted transition hover:bg-raised hover:text-danger disabled:opacity-50"
              >{busy === "delete" ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}删除项目</button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-xl border border-line bg-surface/70 px-2.5 py-1.5">
        <FolderKanban size={14} className="mt-[5px] shrink-0 text-accent" />
        {view.archived && (
          <span className="mt-[3px] shrink-0 rounded bg-raised px-1.5 text-[11px] leading-5 text-fg-muted" title="已归档：在会话列表最下面的「已归档」里。点「项目信息」可以取消归档">已归档</span>
        )}
        <div className="flex max-h-[62px] min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-y-auto">
          {view.ownedHere ? (
            view.steps.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => void runStep(s.id)}
                disabled={!!starting}
                title={`点一下，AI 开始做「${s.label}」${view.templateNames.length > 1 ? `（${s.group}）` : ""}`}
                className="inline-flex items-center gap-1 rounded-full border border-line bg-page/60 px-2.5 py-0.5 text-[12px] text-fg-3 transition hover:border-focus/60 hover:text-accent disabled:opacity-60"
              >
                {starting === s.id && <Loader2 size={11} className="animate-spin" />}{s.label}
              </button>
            ))
          ) : (
            <span className="py-0.5 text-[12px] text-fg-muted">这个项目归其它通道管（比如飞书），这里只能聊天和查看；快捷操作请到它所在的聊天里点。</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title="项目信息、成果、归档、删除项目"
          className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] transition hover:bg-raised hover:text-fg-soft ${open ? "bg-raised text-accent" : "text-fg-muted"}`}
        ><Info size={13} />项目信息</button>
      </div>
    </div>
  )
}

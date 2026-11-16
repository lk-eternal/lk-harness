import { useEffect, useRef, type ReactNode } from "react"
import { Download, FilePlus, FolderKanban, GitBranch, LayoutTemplate, Plus, Settings2 } from "lucide-react"
import type { ProjectListItem } from "../../../shared/project-app-types"
import { sectionOfSel, type ProjectsSel } from "./projects-nav"
import { isCodeGroup, type Group } from "./template-data"

interface Props {
  sel: ProjectsSel
  go: (next: ProjectsSel) => void
  projects: ProjectListItem[]
  groups: Group[]
  /** 配了共享空间地址才出现「从共享空间获取」 */
  hubUrlReady: boolean
  onImport: () => void
  onOpenHub: () => void
  /** 窗口窄、右边要给模板的两栏腾地方时先收起来（还在 DOM 里，只是不显示） */
  folded?: boolean
}

const itemCls = (on: boolean) =>
  `flex w-full flex-col rounded-md px-2.5 py-1.5 text-left transition ${on ? "bg-raised/70 text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`

/** 分区的标题条：固定在分区顶上，不随下面的列表滚走；点标题回到这一类的首页 */
function SectionHeader({ id, icon, label, count, active, onClick, right }: { id: "projects" | "templates"; icon: ReactNode; label: string; count: number; active: boolean; onClick: () => void; right?: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line-subtle bg-surface px-1.5 py-1">
      <button
        type="button"
        data-rail-head={id}
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={`flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs font-medium transition ${active ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised/60 hover:text-fg"}`}
      >
        <span className="shrink-0 text-fg-muted">{icon}</span>
        <span>{label}</span>
        <span className="rounded-full bg-strong/60 px-1.5 text-[10px] font-normal leading-4 text-fg-3">{count}</span>
      </button>
      {right}
    </div>
  )
}

/**
 * 「项目」页左边这一栏，从上到下三块：
 * - 项目设置：固定在最顶部，一进来就看得见；
 * - 项目：自己一块，项目再多也只在这一块里滚；
 * - 项目模板：钉在最底下，自己一块（标题条、列表、导入入口），最多占整栏的 40%，模板多了也只在这一块里滚，
 *   所以项目再多，模板和它的「新建」「导入」也始终看得见。
 * 点哪个，右边就出现哪个的内容；模板的下一级（快捷操作）在右边再展开一栏。
 */
export default function ProjectRail({ sel, go, projects, groups, hubUrlReady, onImport, onOpenHub, folded }: Props) {
  const section = sectionOfSel(sel)
  const settingsOn = section === "settings"

  // 选中的那一行在自己的列表里被滚到看不见时（从别处跳过来、新建/导入完成），把它带回视野；本来就看得见就不动
  const rootRef = useRef<HTMLElement>(null)
  const activeKey = sel.kind === "project" ? `p:${sel.id}` : sel.kind === "template" ? `t:${sel.id}` : sel.kind === "new-template" ? "new" : ""
  useEffect(() => {
    if (!activeKey) return
    const row = rootRef.current?.querySelector<HTMLElement>('[data-rail="project"][aria-current="true"], [data-rail="template"][aria-current="true"], [data-rail="new-template"]')
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" })
  }, [activeKey, projects.length, groups.length])

  return (
    <aside ref={rootRef} className={`${folded ? "hidden" : "flex"} w-48 shrink-0 flex-col border-r border-line-subtle`} aria-label="项目导航">
      <div className="shrink-0 border-b border-line-subtle px-2 py-1.5">
        <button
          type="button"
          data-rail="settings"
          aria-current={settingsOn ? "true" : undefined}
          title="项目存放位置、常用代码仓库、GitLab、团队共享"
          onClick={() => go({ kind: "settings" })}
          className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition ${settingsOn ? "bg-raised/70 text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}
        >
          <Settings2 size={15} className="shrink-0" />
          <span className="flex min-w-0 flex-col">
            <span className={`text-xs ${settingsOn ? "font-medium" : ""}`}>项目设置</span>
            <span className="truncate text-[10px] text-fg-faint">存放位置、仓库、团队共享</span>
          </span>
        </button>
      </div>

      <section data-rail-section="projects" className="flex min-h-[7rem] flex-1 flex-col" aria-label="项目">
        <SectionHeader
          id="projects"
          icon={<FolderKanban size={13} />}
          label="项目"
          count={projects.length}
          active={sel.kind === "projects-home"}
          onClick={() => go({ kind: "projects-home" })}
        />
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
          {projects.map((p) => {
            const on = sel.kind === "project" && sel.id === p.id
            return (
              <button key={p.id} type="button" data-rail="project" aria-current={on ? "true" : undefined} onClick={() => go({ kind: "project", id: p.id })} className={`${itemCls(on)} ${p.archived && !on ? "opacity-60" : ""}`}>
                <span className={`truncate text-xs ${on ? "font-medium" : ""}`}>{p.name}</span>
                <span className="truncate text-[10px] text-fg-faint">{p.archived ? "已归档 · " : ""}{p.groupNames.join("、") || "普通项目"}</span>
              </button>
            )
          })}
          {projects.length === 0 && <p className="px-2.5 py-1.5 text-[11px] leading-snug text-fg-faint">还没有项目。在对话页点「新项目」创建。</p>}
        </div>
      </section>

      <section data-rail-section="templates" className="flex max-h-[40%] shrink-0 flex-col border-t-2 border-line bg-surface/50" aria-label="项目模板">
        <SectionHeader
          id="templates"
          icon={<LayoutTemplate size={13} />}
          label="项目模板"
          count={groups.length}
          active={sel.kind === "templates-home"}
          onClick={() => go({ kind: "templates-home" })}
          right={
            <button
              type="button"
              title="新建项目模板"
              aria-label="新建项目模板"
              onClick={() => go({ kind: "new-template" })}
              className="rounded p-1.5 text-fg-muted transition hover:bg-raised hover:text-fg-2"
            ><Plus size={13} /></button>
          }
        />
        <div className="min-h-0 flex-auto space-y-0.5 overflow-y-auto p-2">
          {groups.map((g) => {
            const on = sel.kind === "template" && sel.id === g.id
            return (
              <button key={g.id} type="button" data-rail="template" aria-current={on ? "true" : undefined} onClick={() => go({ kind: "template", id: g.id, leaf: { kind: "info" } })} className={itemCls(on)}>
                <span className={`truncate text-xs ${on ? "font-medium" : ""}`}>{g.name}</span>
                <span className="flex items-center gap-1 truncate text-[10px] text-fg-faint">
                  {isCodeGroup(g) ? <><GitBranch size={9} />研发</> : "通用"} · {g.nodes.length} 个快捷操作
                </span>
              </button>
            )
          })}
          {sel.kind === "new-template" && (
            <div data-rail="new-template" className={itemCls(true)} aria-current="true"><span className="text-xs font-medium">新模板</span><span className="text-[10px] text-fg-faint">正在创建…</span></div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-1 border-t border-line-subtle px-2 py-1">
          <button type="button" onClick={onImport} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-muted transition hover:bg-raised hover:text-fg-2"><FilePlus size={11} />导入文件</button>
          {hubUrlReady && (
            <button type="button" onClick={onOpenHub} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-muted transition hover:bg-raised hover:text-fg-2"><Download size={11} />共享空间</button>
          )}
        </div>
      </section>
    </aside>
  )
}

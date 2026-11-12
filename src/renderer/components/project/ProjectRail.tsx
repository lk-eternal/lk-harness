import type { ReactNode } from "react"
import { Download, FilePlus, GitBranch, Plus, Settings2 } from "lucide-react"
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

function SectionHeader({ label, count, active, onClick, right }: { label: string; count: number; active: boolean; onClick: () => void; right?: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center bg-page pb-1 pt-2">
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={`flex min-w-0 flex-1 items-baseline gap-1.5 rounded px-2.5 py-1 text-left text-[11px] font-medium uppercase tracking-wide transition ${active ? "text-fg" : "text-fg-muted hover:text-fg-2"}`}
      >
        <span>{label}</span>
        <span className="font-normal normal-case tracking-normal text-fg-faint">{count}</span>
      </button>
      {right}
    </div>
  )
}

/**
 * 「项目」页左边这一栏：上面是项目，中间是项目模板，底部是项目设置。
 * 点哪个，右边就出现哪个的内容；模板的下一级（快捷操作）在右边再展开一栏。
 */
export default function ProjectRail({ sel, go, projects, groups, hubUrlReady, onImport, onOpenHub, folded }: Props) {
  const section = sectionOfSel(sel)
  return (
    <aside className={`${folded ? "hidden" : "flex"} w-48 shrink-0 flex-col border-r border-line-subtle`} aria-label="项目导航">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SectionHeader label="项目" count={projects.length} active={sel.kind === "projects-home"} onClick={() => go({ kind: "projects-home" })} />
        <div className="space-y-0.5">
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

        <SectionHeader
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
              className="mr-0.5 rounded p-1 text-fg-muted transition hover:bg-raised hover:text-fg-2"
            ><Plus size={13} /></button>
          }
        />
        <div className="space-y-0.5">
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
            <div className={itemCls(true)} aria-current="true"><span className="text-xs font-medium">新模板</span><span className="text-[10px] text-fg-faint">正在创建…</span></div>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1 px-1">
          <button type="button" onClick={onImport} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-muted transition hover:bg-raised hover:text-fg-2"><FilePlus size={11} />导入文件</button>
          {hubUrlReady && (
            <button type="button" onClick={onOpenHub} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-fg-muted transition hover:bg-raised hover:text-fg-2"><Download size={11} />共享空间</button>
          )}
        </div>
      </div>

      <div className="border-t border-line-subtle p-2">
        <button
          type="button"
          aria-current={section === "settings" ? "true" : undefined}
          onClick={() => go({ kind: "settings" })}
          className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition ${section === "settings" ? "bg-raised/70 font-medium text-fg" : "text-fg-3 hover:bg-raised/40 hover:text-fg-soft"}`}
        ><Settings2 size={13} />项目设置</button>
      </div>
    </aside>
  )
}

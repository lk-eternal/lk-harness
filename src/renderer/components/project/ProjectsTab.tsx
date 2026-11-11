import { useCallback, useEffect, useRef, useState } from "react"
import { FlowHubBrowser } from "../FlowHubBrowser"
import useInlineModal from "../useInlineModal"
import type { ProjectListItem } from "../../../shared/project-app-types"
import { applyTemplateEdit, buildNewTemplate, type TemplateDraft } from "../../../shared/project-template-edit"
import type { ActionItem } from "./ActionEditor"
import ProjectDetail from "./ProjectDetail"
import ProjectRail from "./ProjectRail"
import ProjectSettingsPanel from "./ProjectSettingsPanel"
import { ProjectsHome, TemplatesHome } from "./ProjectsHome"
import TemplateInfoEditor from "./TemplateInfoEditor"
import TemplateWorkspace, { type TemplateOps } from "./TemplateWorkspace"
import { isNarrowLayout, landingSel, resolveSel, sameSel, selForJump, type ProjectsJump, type ProjectsSel } from "./projects-nav"
import { toStored, type Action, type Group } from "./template-data"
import type { RegisterGuard, UnsavedGuard } from "./project-ui"

interface Props {
  /** 从别处（比如新建项目对话框）要求直接落在某处 */
  jump?: ProjectsJump
  /** 跳转请求已处理：设置页据此清掉请求，之后手动切走再切回来仍然从头开始 */
  onJumpConsumed?: () => void
}

/**
 * 设置页「项目」标签：左边一栏放项目、项目模板和项目设置，点哪个右边出现哪个；
 * 模板再往下一级是它的快捷操作，在右边再展开一栏。各处的编辑区有没保存的修改时，切走前统一在这里问。
 */
export default function ProjectsTab({ jump, onJumpConsumed }: Props) {
  const { showAlert, showConfirm, showUnsavedChoice, ModalPortal } = useInlineModal()
  const [sel, setSel] = useState<ProjectsSel>(() => (jump ? selForJump(jump.sub) : { kind: "projects-home" }))
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null)
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [hub, setHub] = useState({ urlReady: false, configured: false })
  const [hubBrowser, setHubBrowser] = useState<{ kind: "group" | "node"; groupId?: string } | null>(null)

  const selRef = useRef(sel)
  selRef.current = sel
  const guardRef = useRef<UnsavedGuard | null>(null)
  const registerGuard = useCallback<RegisterGuard>((g) => { guardRef.current = g }, [])
  const alive = useRef(true)
  const firstLoad = useRef(true)

  const load = useCallback(async () => {
    const [list, gs, cfg] = await Promise.all([
      window.electronAPI.listProjects().catch(() => [] as ProjectListItem[]),
      window.electronAPI.getProjectNodeGroups().catch(() => [] as Group[]),
      window.electronAPI.getConfig().catch(() => null),
    ])
    if (!alive.current) return
    setProjects(list)
    setGroups(gs)
    if (cfg) {
      const urlReady = (cfg.flowHubUrl ?? "").trim().length > 0
      setHub({ urlReady, configured: urlReady && ((cfg.flowHubToken ?? "").trim().length > 0 || (cfg.gitlabToken ?? "").trim().length > 0) })
    }
    const ctx = { projectIds: list.map((p) => p.id), templates: gs.map((g) => ({ id: g.id, actionIds: g.nodes.map((n) => n.id) })) }
    const first = firstLoad.current
    firstLoad.current = false
    setSel((prev) => {
      const resolved = resolveSel(prev, ctx)
      return first ? landingSel(resolved, ctx.projectIds) : resolved
    })
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => { alive.current = false }
  }, [load])

  // 设置页是常驻的（只是被藏起来）：在别处建了、删了项目，再回到这里要重新读，不然左栏还是旧的
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === "undefined") return
    let visible: boolean | undefined
    const io = new IntersectionObserver((entries) => {
      const now = entries[entries.length - 1].isIntersecting
      if (now && visible === false) void load()
      visible = now
    })
    io.observe(el)
    return () => io.disconnect()
  }, [load])

  // 内容区的宽度：窄了（应用默认窗口就是）模板往下点到快捷操作时，最左的栏先收起来
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1].contentRect.width
      if (w > 0) setNarrow(isNarrowLayout(w)) // 被藏起来时宽度是 0：不知道，保持原样
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 切到别处：当前编辑区有没保存的修改就先问；用户取消、或要求保存却没保存成，就留在原地 */
  const go = useCallback(async (next: ProjectsSel) => {
    if (sameSel(next, selRef.current)) return
    const g = guardRef.current
    if (g?.dirty) {
      const choice = await showUnsavedChoice("有没保存的修改", "离开前要保存这里的修改吗？", { save: "保存并离开", discard: "放弃修改" })
      if (choice === "cancel") return
      if (choice === "save" && !(await g.save())) return
    }
    setSel(next)
  }, [showUnsavedChoice])

  // 这个标签已经挂着时（设置页是常驻的）收到的新请求，也要跳过去
  useEffect(() => {
    if (!jump) return
    void go(selForJump(jump.sub))
    onJumpConsumed?.()
  }, [jump, go, onJumpConsumed])

  const gs = groups ?? []
  const allActionIds = gs.flatMap((g) => g.nodes.map((n) => n.id))

  const persist = async (next: Group[]) => {
    await window.electronAPI.saveProjectNodeGroups(toStored(next))
    await load()
  }

  const openHub = (kind: "group" | "node", groupId?: string) => {
    if (!hub.configured) {
      void showAlert("还不能用共享空间", "请先在「项目设置 → 团队共享（高级）」里填好共享空间地址，再填共享空间 Token（或「研发」里的 GitLab Token）。")
      return
    }
    setHubBrowser({ kind, groupId })
  }

  const importTemplate = async () => {
    const r = await window.electronAPI.importProjectNodeGroup()
    if (!r.ok) {
      if (r.error !== "已取消") void showAlert("导入失败", r.error ?? "未知错误")
      return
    }
    await load()
    if (r.group) {
      setSel({ kind: "template", id: r.group.id, leaf: { kind: "info" } })
      void showAlert("导入成功", `已导入为新模板「${r.group.name}」。`)
    }
  }

  const createTemplate = async (draft: TemplateDraft) => {
    const g = buildNewTemplate(draft, gs.map((x) => x.id), allActionIds)
    await persist([...gs, { ...g, nodes: g.nodes.map((n) => ({ ...n })) }])
    setSel({ kind: "template", id: g.id, leaf: { kind: "action", id: g.nodes[0].id } })
  }

  const ops: TemplateOps = {
    saveInfo: async (groupId: string, draft: TemplateDraft) => {
      await persist(gs.map((g) => (g.id === groupId ? { ...applyTemplateEdit(g, draft), nodes: g.nodes } : g)))
    },
    saveAction: async (groupId: string, item: ActionItem, isNew: boolean) => {
      const g = gs.find((x) => x.id === groupId)
      if (!g) return
      const nodes: Action[] = isNew ? [...g.nodes, item] : g.nodes.map((n) => (n.id === item.id ? { ...n, ...item } : n))
      await persist(gs.map((x) => (x.id === groupId ? { ...x, nodes } : x)))
      if (isNew) setSel({ kind: "template", id: groupId, leaf: { kind: "action", id: item.id } })
    },
    deleteAction: async (groupId: string, actionId: string) => {
      const g = gs.find((x) => x.id === groupId)
      if (!g) return
      if (g.nodes.length <= 1) { void showAlert("无法删除", "模板里至少要留一个快捷操作，否则用它建不了项目"); return }
      const label = g.nodes.find((n) => n.id === actionId)?.label || actionId
      if (!(await showConfirm("删除快捷操作", `确定删除「${label}」？已经建好的项目不受影响。`))) return
      await persist(gs.map((x) => (x.id === groupId ? { ...x, nodes: x.nodes.filter((n) => n.id !== actionId) } : x)))
      setSel({ kind: "template", id: groupId, leaf: { kind: "info" } })
    },
    reorderActions: async (groupId: string, nodes: Action[]) => {
      await persist(gs.map((x) => (x.id === groupId ? { ...x, nodes } : x)))
    },
    deleteTemplate: async (groupId: string) => {
      const g = gs.find((x) => x.id === groupId)
      if (!g) return
      if (gs.length <= 1) { void showAlert("无法删除", "至少保留 1 个项目模板。"); return }
      const usage = await window.electronAPI.getProjectNodeGroupUsage().catch(() => ({} as Record<string, number>))
      const count = usage[groupId] ?? 0
      if (count > 0) { void showAlert("无法删除", `还有 ${count} 个老项目在用这个模板，先处理那些项目再删。`); return }
      if (!(await showConfirm("删除项目模板", `确定删除「${g.name}」？里面的 ${g.nodes.length} 个快捷操作会一起删除。已经建好的项目不受影响。`))) return
      await persist(gs.filter((x) => x.id !== groupId))
      setSel({ kind: "templates-home" })
    },
    exportTemplate: async (groupId: string) => {
      const r = await window.electronAPI.exportProjectNodeGroup(groupId)
      if (r.ok && r.path) void showAlert("导出成功", `已保存到：${r.path}\n把这个文件发给同事，对方在「项目模板」里点「导入文件」就能用。`)
      else if (!r.ok && r.error !== "已取消") void showAlert("导出失败", r.error ?? "未知错误")
    },
    uploadTemplate: async (groupId: string) => {
      const g = gs.find((x) => x.id === groupId)
      const r = await window.electronAPI.flowHub.uploadGroup(groupId)
      if (r.ok) { void showAlert("上传成功", `项目模板「${g?.name ?? groupId}」已上传到共享空间`); await load() }
      else void showAlert("上传失败", r.error ?? "未知错误")
    },
    uploadAction: async (groupId: string, actionId: string) => {
      const r = await window.electronAPI.flowHub.uploadNode(groupId, actionId)
      if (r.ok) void showAlert("上传成功", "快捷操作已上传到共享空间")
      else void showAlert("上传失败", r.error ?? "未知错误")
    },
    openHubActions: (groupId: string) => openHub("node", groupId),
  }

  const loading = projects === null || groups === null
  const project = sel.kind === "project" ? projects?.find((p) => p.id === sel.id) : undefined
  const template = sel.kind === "template" ? gs.find((g) => g.id === sel.id) : undefined
  const ui = { showAlert, showConfirm }
  // 窄窗口里点进模板的快捷操作时，最左的栏收起来，由快捷操作列表顶上的「全部模板」返回
  const foldRail = narrow && sel.kind === "template"

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1">
      <ProjectRail
        folded={foldRail}
        sel={sel}
        go={(next) => void go(next)}
        projects={projects ?? []}
        groups={gs}
        hubUrlReady={hub.urlReady}
        onImport={() => void importTemplate()}
        onOpenHub={() => openHub("group")}
      />

      <div className="flex min-h-0 min-w-0 flex-1 pl-4">
        {sel.kind === "projects-home" && <ProjectsHome count={projects?.length ?? 0} />}
        {sel.kind === "project" && project && (
          <ProjectDetail
            key={project.id}
            item={project}
            groups={gs}
            ui={ui}
            onChanged={load}
            onDeleted={load}
            onOpenTemplate={(id) => void go({ kind: "template", id, leaf: { kind: "info" } })}
            registerGuard={registerGuard}
          />
        )}
        {sel.kind === "templates-home" && (
          <TemplatesHome
            hubUrlReady={hub.urlReady}
            onNew={() => void go({ kind: "new-template" })}
            onImport={() => void importTemplate()}
            onOpenHub={() => openHub("group")}
          />
        )}
        {sel.kind === "new-template" && (
          <TemplateInfoEditor
            key="new-template"
            mode="create"
            otherNames={gs.map((g) => g.name)}
            onSubmit={createTemplate}
            onCancel={() => setSel({ kind: "templates-home" })}
            registerGuard={registerGuard}
          />
        )}
        {sel.kind === "template" && template && (
          <TemplateWorkspace
            key={template.id}
            group={template}
            leaf={sel.leaf}
            groups={gs}
            go={(next) => void go(next)}
            ops={ops}
            hubUrlReady={hub.urlReady}
            hubConfigured={hub.configured}
            ui={ui}
            registerGuard={registerGuard}
            onBack={foldRail ? () => void go({ kind: "templates-home" }) : undefined}
          />
        )}
        {sel.kind === "settings" && <ProjectSettingsPanel />}
        {loading && (sel.kind === "project" || sel.kind === "template") && !project && !template && (
          <div className="flex-1 p-6 text-sm text-fg-muted">加载中…</div>
        )}
      </div>

      {hubBrowser && (
        <FlowHubBrowser
          kind={hubBrowser.kind}
          targetGroupId={hubBrowser.groupId}
          onClose={() => setHubBrowser(null)}
          onImported={() => { void load(); setHubBrowser(null) }}
          showAlert={showAlert}
          showConfirm={showConfirm}
        />
      )}
      {ModalPortal}
    </div>
  )
}

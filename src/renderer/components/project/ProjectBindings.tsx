import { useEffect, useMemo, useState } from "react"
import { Link2, Loader2, Plus, X } from "lucide-react"
import type { ProjectBindingChoice, ProjectBindingItem, ProjectChannelOption, ProjectListItem } from "../../../shared/project-app-types"
// 只取类型：project-types 里有 node 专用的代码，不能被渲染进程打包进去
import type { ProjectChatMode } from "../../../shared/project-types"
import { Section, dashedBtn, ghostBtn, smallInputCls } from "./project-ui"

const MODE_LABEL: Record<ProjectChatMode, string> = {
  inline: "主聊天（不建群）",
  group: "新建独立群",
  bind: "绑定已有群",
}

interface Props {
  item: ProjectListItem
  ui: { showAlert: (title: string, msg: string) => Promise<void>; showConfirm: (title: string, msg: string, ok?: string, cancel?: string) => Promise<boolean> }
  /** 接入变了：让外壳重新读项目列表 */
  onChanged: () => Promise<void>
}

/** 项目详情里的「接入的聊天」：看项目接入了哪些通道（主聊天 / 专属群），加接入、取消接入 */
export default function ProjectBindings({ item, ui, onChanged }: Props) {
  const [options, setOptions] = useState<ProjectChannelOption[]>([])
  const [adding, setAdding] = useState(false)
  const [channelId, setChannelId] = useState("")
  const [mode, setMode] = useState<ProjectChatMode>("inline")
  const [groupChatId, setGroupChatId] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    window.electronAPI.listProjectChannelOptions().then((list) => { if (alive) setOptions(list) }).catch(() => { /* 读不到就只显示通道 ID */ })
    return () => { alive = false }
  }, [])

  const nameOf = (id: string) => options.find((o) => o.id === id)?.name ?? (id || "未知通道")

  /** 这个通道上还能加的方式：主聊天、专属群各自只能有一个（要换群先取消原来的），绑已有群随时可以再加 */
  const modesFor = (o: ProjectChannelOption): ProjectChatMode[] =>
    o.modes.filter((m) =>
      !(m === "inline" && item.bindings.some((b) => b.kind === "main" && b.channelId === o.id))
      && !(m === "group" && item.bindings.some((b) => b.kind === "group" && b.channelId === o.id)))

  const addable = useMemo(
    () => options.filter((o) => modesFor(o).length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, item.bindings],
  )
  const picked = addable.find((o) => o.id === channelId) ?? addable[0]
  const pickedModes = picked ? modesFor(picked) : []
  const effectiveMode: ProjectChatMode = pickedModes.includes(mode) ? mode : (pickedModes[0] ?? "inline")

  const openAdd = () => {
    setChannelId(addable[0]?.id ?? "")
    setMode("inline")
    setGroupChatId("")
    setAdding(true)
  }

  const add = async () => {
    if (!picked || busy) return
    const choice: ProjectBindingChoice = {
      channelId: picked.id,
      mode: effectiveMode,
      ...(effectiveMode === "bind" ? { groupChatId: groupChatId.trim() } : {}),
    }
    if (choice.mode === "bind" && !choice.groupChatId) { void ui.showAlert("还不能接入", "绑定已有群要填群 ID（oc_ 开头）"); return }
    setBusy(true)
    try {
      const r = await window.electronAPI.bindProject(item.id, [choice])
      if (!r.ok) { void ui.showAlert("接入失败", r.error); return }
      setAdding(false)
      await onChanged()
      if (r.warning) void ui.showAlert("接入了，但有一点没做成", r.warning)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (b: ProjectBindingItem) => {
    if (busy) return
    const what = b.kind === "group" ? `「${nameOf(b.channelId)}」的专属群` : `「${nameOf(b.channelId)}」的主聊天`
    const ok = await ui.showConfirm(
      "取消接入",
      `取消后，${what}里不再看得到这个项目，那条会话（应用里的聊天记录也会一并删除）会被清理。${b.kind === "group" ? "群本身不会改名，也不会解散。" : ""}项目和它的文件不受影响。`,
      "取消接入",
      "保留",
    )
    if (!ok) return
    setBusy(true)
    try {
      const choice: ProjectBindingChoice = b.kind === "group"
        ? { channelId: b.channelId, mode: "group", ...(b.chatKey ? { groupChatId: b.chatKey } : {}) }
        : { channelId: b.channelId, mode: "inline" }
      const r = await window.electronAPI.unbindProject(item.id, choice)
      if (!r.ok) { void ui.showAlert("取消接入失败", r.error); return }
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  const onlyOne = item.bindings.length <= 1

  return (
    <Section
      title="接入的聊天"
      hint="只有接入了的通道里才看得到、用得了这个项目；每个通道各自一条独立会话，互不通消息。"
    >
      {item.bindings.length === 0 ? (
        <p className="text-[11.5px] text-fg-muted">还没有接入任何聊天：谁都看不到这个项目，只能在这里管理。</p>
      ) : (
        <ul className="space-y-1.5" data-testid="project-bindings">
          {item.bindings.map((b) => {
            const rawChat = b.chatKey?.split("|").pop() ?? ""
            return (
              <li key={`${b.kind}:${b.channelId}:${b.chatKey ?? ""}`} className="flex items-center gap-2 rounded-lg border border-line-subtle bg-surface/50 px-3 py-1.5 text-xs">
                <Link2 size={12} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-fg-2">
                  {nameOf(b.channelId)} · {b.kind === "group" ? `专属群 ${rawChat}` : "主聊天"}
                </span>
                {b.channelId && (
                  <button
                    type="button"
                    disabled={busy || onlyOne}
                    title={onlyOne ? "这是项目唯一的接入：先接入别的聊天再取消它，或者直接归档 / 删除项目" : "取消这个接入"}
                    aria-label="取消这个接入"
                    onClick={() => void remove(b)}
                    className="shrink-0 rounded-md border border-line p-1 text-fg-3 transition hover:bg-raised hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-3"
                  ><X size={12} /></button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {adding && picked ? (
        <div className="space-y-2 rounded-lg border border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={picked.id}
              disabled={busy}
              onChange={(e) => { setChannelId(e.target.value); setMode("inline") }}
              aria-label="接入的通道"
              className={smallInputCls}
            >
              {addable.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <select
              value={effectiveMode}
              disabled={busy}
              onChange={(e) => setMode(e.target.value as ProjectChatMode)}
              aria-label="接入方式"
              className={smallInputCls}
            >
              {pickedModes.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          </div>
          {effectiveMode === "bind" && (
            <input
              value={groupChatId}
              disabled={busy}
              placeholder="已有群的 ID（oc_ 开头），机器人要已经在群里"
              onChange={(e) => setGroupChatId(e.target.value)}
              className={`${smallInputCls} w-full`}
            />
          )}
          {effectiveMode === "group" && <p className="text-[11.5px] text-fg-muted">会建一个专属飞书群并把你拉进去，后续在群里协作。</p>}
          {picked.note && <p className="text-[11.5px] text-fg-muted">{picked.note}</p>}
          <div className="flex items-center gap-1">
            <button type="button" disabled={busy} onClick={() => void add()} className={`${ghostBtn} inline-flex items-center gap-1 bg-raised/60`}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : null}接入
            </button>
            <button type="button" disabled={busy} onClick={() => setAdding(false)} className={ghostBtn}>取消</button>
          </div>
        </div>
      ) : (
        addable.length > 0 && <button type="button" onClick={openAdd} className={dashedBtn}><Plus size={13} />添加接入</button>
      )}
    </Section>
  )
}

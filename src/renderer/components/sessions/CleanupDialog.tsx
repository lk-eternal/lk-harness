import { useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import type { CleanupPlan } from "../../../shared/managed-sessions"
import { ModalShell, modalBtnDanger, modalBtnGhost } from "../ModalShell"
import SessionTypeIcon from "./SessionTypeIcon"
import {
  CLEANUP_DEFAULT_DAYS,
  DAEMON_DOWN_HINT,
  cleanupResultText,
  cleanupSummary,
  lastActiveText,
  othersType,
  parseCleanupDays,
  sortCleanupCandidates,
} from "./sessions-view"

type Preview =
  | { status: "loading" }
  | { status: "ok"; plan: CleanupPlan }
  | { status: "error"; error: string }

/** 预览里最多列出的行数；多出来的只写个数（删除时仍然是全部候选） */
const LIST_LIMIT = 50

/**
 * 批量清理：只清「其他人的普通会话」里久未活动、且没有运行 / 排队 / 人为设置的。
 * 流程：改天数 → 自动预览（列出会删谁、另有多少因何被保留）→ 点删除 → 再确认一次 → 执行。
 * 预览与执行都由主进程各自重新判定，这里列出的只是「点之前看到的」。
 */
export default function CleanupDialog({
  channelId,
  channelName,
  daemonRunning,
  confirm,
  onClose,
  onChanged,
}: {
  channelId: string
  channelName: string
  daemonRunning: boolean
  confirm: (title: string, message: string, ok?: string, cancel?: string) => Promise<boolean>
  onClose: () => void
  /** 真的删过东西后调用，让外面的清单刷新 */
  onChanged: () => void
}) {
  const [daysText, setDaysText] = useState(String(CLEANUP_DEFAULT_DAYS))
  const days = parseCleanupDays(daysText)
  const [preview, setPreview] = useState<Preview>({ status: "loading" })
  /** 执行完后加一，触发重新预览 */
  const [nonce, setNonce] = useState(0)
  const [running, setRunning] = useState(false)
  const [resultText, setResultText] = useState("")

  useEffect(() => {
    if (days === undefined) return
    let cancelled = false
    setPreview({ status: "loading" })
    // 输入时稍等一下再请求，别每敲一个数字就扫一遍磁盘
    const t = setTimeout(() => {
      window.electronAPI
        .previewSessionCleanup({ olderThanDays: days, channelId })
        .then((r) => {
          if (cancelled) return
          if (!r.ok || !r.plan) setPreview({ status: "error", error: r.error ?? "预览失败" })
          else setPreview({ status: "ok", plan: r.plan })
        })
        .catch((e: unknown) => {
          if (!cancelled) setPreview({ status: "error", error: e instanceof Error ? e.message : String(e) })
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [days, channelId, nonce])

  const plan = preview.status === "ok" ? preview.plan : undefined
  const summary = useMemo(() => (plan ? cleanupSummary(plan) : undefined), [plan])
  const sorted = useMemo(() => (plan ? sortCleanupCandidates(plan.candidates) : []), [plan])
  const canRun = !!plan && plan.candidates.length > 0 && daemonRunning && !running
  const now = Date.now()

  const run = async () => {
    if (!plan || !canRun) return
    const n = plan.candidates.length
    const ok = await confirm(
      "再确认一次",
      `将永久删除「${channelName}」里 ${n} 个超过 ${plan.olderThanDays} 天没有活动的会话（含全部上下文），不可恢复。\n对方下次发消息会开启全新的会话，不会收到通知。`,
      `删除 ${n} 个`,
      "取消",
    )
    if (!ok) return
    setRunning(true)
    try {
      const r = await window.electronAPI.runSessionCleanup({
        olderThanDays: plan.olderThanDays,
        channelId,
        sessionKeys: plan.candidates.map((c) => c.sessionKey),
      })
      setResultText(cleanupResultText(r))
      if (r.deleted.length > 0) onChanged()
    } catch (e) {
      setResultText(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
      setNonce((x) => x + 1)
    }
  }

  return (
    <ModalShell
      title={`清理「${channelName}」里久未使用的会话`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {!daemonRunning && <span className="mr-auto text-xs text-warning-soft">{DAEMON_DOWN_HINT}</span>}
          <button type="button" className={modalBtnGhost} onClick={onClose} disabled={running}>关闭</button>
          <button
            type="button"
            className={modalBtnDanger}
            disabled={!canRun}
            title={!daemonRunning ? DAEMON_DOWN_HINT : undefined}
            onClick={() => void run()}
          >
            {running ? "清理中…" : plan && plan.candidates.length > 0 ? `删除 ${plan.candidates.length} 个会话` : "没有可清理的"}
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-fg-3">
          只清理其他人的普通会话；正在运行、有排队消息、单独改过模型 / 供应商 / 推理档的会话不会动。主用户的会话、项目和定时任务不在范围内。
        </p>
        <label className="flex items-center gap-2 text-xs text-fg-2">
          清理超过
          <input
            value={daysText}
            onChange={(e) => setDaysText(e.target.value)}
            inputMode="numeric"
            aria-label="天数"
            className={`w-16 rounded border bg-surface px-2 py-1 text-center text-fg ${days === undefined ? "border-danger-line" : "border-line"}`}
          />
          天没有活动的会话
        </label>
        {days === undefined && <p className="text-xs text-danger-soft">请输入 1–3650 之间的整数天数</p>}

        {days !== undefined && preview.status === "loading" && (
          <p className="flex items-center gap-1.5 text-xs text-fg-muted"><Loader2 size={12} className="animate-spin" />正在统计…</p>
        )}
        {preview.status === "error" && days !== undefined && <p className="text-xs text-danger-soft">{preview.error}</p>}

        {days !== undefined && plan && summary && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-fg-soft">{summary.headline}</div>
            {sorted.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded border border-line-subtle/70">
                {sorted.slice(0, LIST_LIMIT).map((s) => (
                  <div key={s.sessionKey} className="flex items-center gap-1.5 border-b border-line-subtle/60 px-2 py-1 text-xs last:border-b-0">
                    <SessionTypeIcon type={othersType(s)} size={11} />
                    <span className="min-w-0 truncate text-fg-2" title={s.sessionKey}>{s.name}</span>
                    {s.preview && <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">{s.preview}</span>}
                    <span className="ml-auto shrink-0 text-[11px] text-fg-muted">{lastActiveText(s, now)}</span>
                  </div>
                ))}
                {sorted.length > LIST_LIMIT && (
                  <div className="px-2 py-1 text-center text-[11px] text-fg-faint">另有 {sorted.length - LIST_LIMIT} 个未列出，一并清理</div>
                )}
              </div>
            )}
            {summary.kept.length > 0 && (
              <ul className="space-y-0.5 text-[11px] text-fg-muted">
                {summary.kept.map((line) => <li key={line}>· {line}</li>)}
              </ul>
            )}
          </div>
        )}

        {resultText && <p className="rounded bg-raised/60 px-2 py-1.5 text-xs text-fg-soft">{resultText}</p>}
      </div>
    </ModalShell>
  )
}

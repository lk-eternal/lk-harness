import { useState } from "react"
import {
  clearOptionText,
  impactLines,
  stopCount,
  stopOptionText,
  type ChannelModelImpact,
} from "../../shared/channel-model-impact"
import type { ImpactChoice } from "../../shared/channel-save-flow"
import { ModalShell, modalBtnGhost, modalBtnPrimary } from "./ModalShell"

export type { ImpactChoice }

/**
 * 保存通道时「其他人的默认模型 / 供应商变了」的确认框：先说清楚影响到哪些会话，
 * 再由用户决定要不要清掉别人单独改过的模型、要不要停掉正在运行的会话。两项默认都不勾——
 * 不勾就只保存，不会动任何人的会话。主用户自己的会话不在这里出现，也不会被动。
 */
export default function ChannelModelImpactDialog({
  channelName,
  impact,
  onDone,
  cancelLabel = "取消",
  cancelHint,
}: {
  channelName: string
  impact: ChannelModelImpact
  /** null = 取消（不保存） */
  onDone: (choice: ImpactChoice | null) => void
  /** 取消按钮的字样；引导向导里取消不是「不保存」，而是「保留原来的模型」 */
  cancelLabel?: string
  /** 取消按钮的补充说明，显示在选项下面 */
  cancelHint?: string
}) {
  const [clear, setClear] = useState(false)
  const [stop, setStop] = useState(false)
  const canClear = impact.modelPinned.total > 0
  const stops = stopCount(impact, canClear && clear)
  // 取消勾选「清除」后，要停的个数可能变成 0，此时不显示这一项，也不带上之前勾的状态
  const showStop = stops > 0
  const doStop = showStop && stop

  return (
    <ModalShell
      title={`「${channelName}」其他人的默认模型要变了`}
      footer={
        <div className="flex w-full justify-end gap-2">
          <button type="button" className={modalBtnGhost} onClick={() => onDone(null)}>{cancelLabel}</button>
          <button
            type="button"
            className={modalBtnPrimary}
            onClick={() => onDone({ clear: canClear && clear, stop: doStop })}
          >保存</button>
        </div>
      }
    >
      <div className="space-y-3">
        <ul className="space-y-1 text-fg-soft">
          {impactLines(impact).map((line) => <li key={line}>{line}</li>)}
        </ul>
        {(canClear || showStop) && (
          <div className="space-y-2 rounded-lg border border-line-subtle bg-raised/40 px-3 py-2.5">
            <p className="text-xs text-fg-muted">下面两项都不勾就只保存设置，不动任何人的会话。主用户自己的会话不受影响。</p>
            {canClear && (
              <label className="flex cursor-pointer items-start gap-2 text-xs text-fg-2">
                <input
                  type="checkbox"
                  checked={clear}
                  onChange={(e) => setClear(e.target.checked)}
                  className="mt-0.5 shrink-0 rounded border-line-strong bg-raised"
                />
                <span>{clearOptionText(impact)}</span>
              </label>
            )}
            {showStop && (
              <label className="flex cursor-pointer items-start gap-2 text-xs text-fg-2">
                <input
                  type="checkbox"
                  checked={stop}
                  onChange={(e) => setStop(e.target.checked)}
                  className="mt-0.5 shrink-0 rounded border-line-strong bg-raised"
                />
                <span>{stopOptionText(impact, canClear && clear)}</span>
              </label>
            )}
          </div>
        )}
        {cancelHint && <p className="text-xs text-fg-muted">{cancelHint}</p>}
      </div>
    </ModalShell>
  )
}

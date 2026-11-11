import { useEffect, useRef, type ReactNode } from "react"

/** 设置页「项目」里各个编辑区共用的样式和小部件 */

/** 输入框的外观，不带宽度：要自己定宽的（和别的元素排一行）用它，别再叠一个 w-xx 去和 w-full 抢 */
export const inputBase = "rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none transition focus:border-blue-500"
export const inputCls = `w-full ${inputBase}`
export const smallInputCls = "rounded-md border border-line bg-surface px-2 py-1 text-xs outline-none transition focus:border-blue-500"
export const ghostBtn = "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs text-fg-3 transition hover:bg-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
export const dashedBtn = "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-dashed border-line px-3 py-1.5 text-xs text-fg-3 transition hover:bg-raised hover:text-fg-2"
export const dangerBtn = "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs text-danger transition hover:bg-danger-tint/30"
export const linkBtn = "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs text-accent transition hover:bg-raised"

/** 离开前的检查：编辑区把「有没有没保存的修改」和「怎么保存」告诉外壳，外壳在切走之前问用户 */
export interface UnsavedGuard {
  dirty: boolean
  /** 保存；返回 false 表示没保存成功（校验没过 / 出错），外壳就不切走 */
  save: () => Promise<boolean>
}
export type RegisterGuard = (guard: UnsavedGuard | null) => void

export function useRegisterGuard(register: RegisterGuard, dirty: boolean, save: () => Promise<boolean>): void {
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    register({ dirty, save: () => saveRef.current() })
  }, [register, dirty])
  useEffect(() => () => register(null), [register])
}

/** 一块内容的小标题 + 说明 */
export function Section({ title, hint, action, children }: { title: string; hint?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-medium text-fg-3">{title}</h4>
        <div className="flex-1" />
        {action}
      </div>
      {hint && <p className="text-[11.5px] leading-relaxed text-fg-muted">{hint}</p>}
      {children}
    </section>
  )
}

export function FieldLabel({ children, optional }: { children: ReactNode; optional?: boolean }) {
  return (
    <span className="mb-1 block text-xs text-fg-muted">
      {children}
      {optional && <span className="text-fg-faint"> （可选）</span>}
    </span>
  )
}

/** 编辑区外框：顶部标题区、中间滚动的内容、底部操作条 */
export function EditorFrame({ header, footer, children }: { header?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {header && <div className="shrink-0 pb-3 pr-4">{header}</div>}
      <div className="flex-1 space-y-5 overflow-y-auto pb-4 pr-4">{children}</div>
      {footer && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-line-subtle py-3 pr-4">{footer}</div>}
    </div>
  )
}

/** 右下角的「还原 / 保存」：没改动时都是灰的，刚保存完短暂显示「已保存」 */
export function SaveButtons({
  dirty, canSave, justSaved, onSave, onRevert, saveLabel = "保存", revertLabel = "还原", busy,
}: {
  dirty: boolean
  canSave: boolean
  justSaved: boolean
  onSave: () => void
  onRevert?: () => void
  saveLabel?: string
  revertLabel?: string
  busy?: boolean
}) {
  return (
    <div className="flex shrink-0 items-center gap-2">
      {onRevert && <button type="button" onClick={onRevert} disabled={!dirty || busy} className={ghostBtn}>{revertLabel}</button>}
      <button
        type="button"
        onClick={onSave}
        disabled={!canSave || busy}
        className={`shrink-0 whitespace-nowrap rounded-md px-4 py-1.5 text-xs font-medium transition disabled:opacity-40 ${justSaved ? "bg-green-600 text-white" : "bg-blue-600 text-white hover:bg-blue-500"}`}
      >{justSaved ? "已保存" : saveLabel}</button>
    </div>
  )
}

/** 没选中任何东西时右边显示的内容 */
export function EmptyPane({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center pr-4">
      <div className="max-w-sm space-y-2 text-center">
        <p className="text-sm font-medium text-fg-2">{title}</p>
        {children && <div className="space-y-2 text-xs leading-relaxed text-fg-muted">{children}</div>}
      </div>
    </div>
  )
}

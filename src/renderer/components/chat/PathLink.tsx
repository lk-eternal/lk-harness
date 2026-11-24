import { Fragment, useEffect, useState, type ReactNode } from "react"
import { findPathMentions, parsePathRef } from "../../../shared/preview-paths"
import type { PreviewPathCheck } from "../../../shared/preview-types"
import { usePreview } from "../preview/PreviewContext"

/**
 * 对话里的文件、文件夹路径：向主进程确认「存在且有权限预览」之后才变成可点的，点了在预览面板里打开
 * （文件带行号就定位到那一行；文件夹打开成文件夹标签页）。
 * 确认不了（没有预览面板、路径不存在、不在这个会话的范围内）就原样显示，不能让每个像路径的文字都像个按钮。
 * stopClick：链接放在一个整块可点的容器里（折叠的工具行是个按钮）时，点路径只开预览，不触发容器自己的点击。
 */
export function PathLink({ raw, line, stopClick, children }: { raw: string; line?: number; stopClick?: boolean; children: ReactNode }) {
  const { available, resolvePath, openFile, openDir } = usePreview()
  const [resolved, setResolved] = useState<PreviewPathCheck | null>(null)
  useEffect(() => {
    setResolved(null)
    if (!available) return
    let cancelled = false
    void resolvePath(raw).then((p) => { if (!cancelled) setResolved(p) })
    return () => { cancelled = true }
  }, [available, resolvePath, raw])
  if (!resolved) return <>{children}</>
  const open = () => {
    // 正在拖选路径文字（想复制）时不要跳走
    if (window.getSelection()?.toString()) return
    if (resolved.isDir) openDir({ path: resolved.path })
    else openFile({ path: resolved.path, line })
  }
  return (
    <span
      role="link"
      tabIndex={0}
      className="lk-path"
      title={line && !resolved.isDir ? `在预览面板打开（第 ${line} 行）：${resolved.path}` : `在预览面板打开：${resolved.path}`}
      onClick={(e) => {
        if (stopClick) e.stopPropagation()
        open()
      }}
      onKeyDown={(e) => { if (e.key === "Enter") open() }}
    >{children}</span>
  )
}

export interface PathTextPart {
  text: string
  /** 这一段是路径时才有 */
  path?: string
  line?: number
}

/**
 * 把一行短文字（工具调用的摘要）拆成「普通文字」和「路径」几段，拼起来和原文一样。
 * 整条文字本身就是一个路径（read 工具的摘要）就整条算，路径里可以有空格；
 * 否则按回复文字里同样的规则找里面夹的路径（shell 命令里的绝对路径），带空格的认不出来。
 */
export function splitPathText(text: string): PathTextPart[] {
  const whole = parsePathRef(text)
  if (whole) return [{ text, path: whole.path, ...(whole.line ? { line: whole.line } : {}) }]
  const parts: PathTextPart[] = []
  let at = 0
  for (const m of findPathMentions(text)) {
    if (m.start > at) parts.push({ text: text.slice(at, m.start) })
    parts.push({ text: text.slice(m.start, m.end), path: m.path, ...(m.line ? { line: m.line } : {}) })
    at = m.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}

/** 一行文字，里面的路径确认能预览后变成可点的 */
export function PathText({ text, stopClick }: { text: string; stopClick?: boolean }) {
  return (
    <>
      {splitPathText(text).map((part, i) => (
        part.path === undefined
          ? <Fragment key={i}>{part.text}</Fragment>
          : <PathLink key={i} raw={part.path} line={part.line} stopClick={stopClick}>{part.text}</PathLink>
      ))}
    </>
  )
}

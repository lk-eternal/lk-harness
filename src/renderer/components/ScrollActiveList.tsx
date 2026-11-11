import { useRef, type ReactNode } from "react"
import { useScrollActiveIntoView } from "./panel-scroll"

/**
 * 可滚动的列表容器：选中项变了、或列表长了一项时，把 aria-current="true" 的行滚进可视区。
 * 单独做成组件，是为了让「用函数直接调用、只看返回元素树」的列表组件不必自己用 hook。
 */
export default function ScrollActiveList({ activeKey, count, className, children }: {
  activeKey: string | null | undefined
  count: number
  className?: string
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useScrollActiveIntoView(ref, activeKey, count)
  return <div ref={ref} className={className}>{children}</div>
}

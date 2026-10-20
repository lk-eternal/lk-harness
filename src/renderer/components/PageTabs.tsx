import { LayoutGrid, MessageSquare } from "lucide-react"

export type MainPage = "dashboard" | "chat"

const TABS = [
  { page: "dashboard", label: "工作台", Icon: LayoutGrid },
  { page: "chat", label: "对话", Icon: MessageSquare },
] as const

interface Props {
  page: MainPage
  onChange: (page: MainPage) => void
}

/** 标题栏中间的页面切换：工作台（状态监控）/ 对话 */
export default function PageTabs({ page, onChange }: Props) {
  return (
    <div className="flex gap-0.5 rounded-full border border-line bg-surface p-[3px]">
      {TABS.map(({ page: p, label, Icon }) => (
        <button
          key={p}
          type="button"
          onClick={() => { if (p !== page) onChange(p) }}
          className={`flex items-center gap-1.5 rounded-full px-4 py-1 text-[13px] transition ${p === page ? "bg-strong font-medium text-fg" : "text-fg-3 hover:text-fg"}`}
        >
          <Icon size={14} />{label}
        </button>
      ))}
    </div>
  )
}

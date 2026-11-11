import { Download, FilePlus, Plus } from "lucide-react"
import { EmptyPane, dashedBtn } from "./project-ui"

/** 项目首页：还没选项目时右边显示的内容 */
export function ProjectsHome({ count }: { count: number }) {
  return count === 0 ? (
    <EmptyPane title="还没有项目">
      <p>项目把一件事的文件夹、对话、资料和快捷操作放在一起，方便长期推进。</p>
      <p>回到对话页，点侧栏里的「新项目」就能创建；创建时选一个项目模板，决定要填什么、有哪些快捷操作。</p>
    </EmptyPane>
  ) : (
    <EmptyPane title="选一个项目">
      <p>在左边选一个项目，查看和修改它的名称、目标和资料。</p>
      <p>新项目在对话页点「新项目」创建。</p>
    </EmptyPane>
  )
}

/** 模板首页：从「没有想要的项目类型」跳过来、或点「项目模板」标题时右边显示的内容 */
export function TemplatesHome({ onNew, onImport, onOpenHub, hubUrlReady }: { onNew: () => void; onImport: () => void; onOpenHub: () => void; hubUrlReady: boolean }) {
  return (
    <EmptyPane title="项目模板">
      <p>新建项目时先选一个模板。模板决定要填哪些信息、项目里有哪些快捷操作。</p>
      <p>快捷操作是预设好提示词的按钮，点一下就让 AI 按提示词做事；不点按钮，直接在对话里说同样的话效果一样。</p>
      <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
        <button type="button" onClick={onNew} className={`${dashedBtn} border-blue-500/60 text-accent`}><Plus size={13} />新建模板</button>
        <button type="button" onClick={onImport} className={dashedBtn}><FilePlus size={13} />导入文件</button>
        {hubUrlReady && <button type="button" onClick={onOpenHub} className={dashedBtn}><Download size={13} />从共享空间获取</button>}
      </div>
      <p className="pt-1 text-[11px] text-fg-faint">想和同事共用模板：导出文件发给对方，对方「导入文件」即可。</p>
    </EmptyPane>
  )
}

import { tasksWithChangedModelSetting, type ScheduledTask } from "./scheduled-task.js"
import { applySessionProviderSwitch } from "./session-model-store.js"
import { getSessionRecord } from "./session-overrides-store.js"

/**
 * 保存任务后，把「跑在哪、用什么模型」改过的任务在会话里登记的旧模型 / 供应商覆盖作废，返回被作废的任务 id。
 *
 * daemon 入队时只在任务有模型才登记覆盖；任务改回「跟随通道」或换了供应商后，旧覆盖不清就会盖过新设置
 * （拉起时供应商取会话覆盖、没配模型时模型也取会话覆盖）。作废后下一次触发按任务现在的设置重新登记。
 *
 * 只处理会话里真有模型 / 供应商记录的任务：对没有记录的会话写补丁会凭空建出一个空会话目录。
 * 会话存储要由调用方先初始化。
 */
export function resetChangedTaskModelOverrides(
  before: readonly ScheduledTask[],
  after: readonly ScheduledTask[],
): string[] {
  const reset: string[] = []
  for (const id of tasksWithChangedModelSetting(before, after)) {
    const rec = getSessionRecord(id)
    if (!rec || (!rec.model && !rec.resourceId)) continue
    applySessionProviderSwitch(id, { resourceId: null, model: null })
    reset.push(id)
  }
  return reset
}

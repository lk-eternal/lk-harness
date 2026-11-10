// ── 定时任务「结果交付」的纯逻辑 ─────────────────────────
// 通知方式（不通知 / 通知到 Agent 会话 / 通知到 IM）涉及：
//   - 设置页的文案、校验、保存前清理（renderer 用）
//   - 独立任务会话的提示词（告诉 AI 怎么用 send_result）
//   - daemon 把结果投到哪、投成什么样（Agent 队列消息 / IM 卡片 / 兜底提示）
//   - 「这次运行有没有提交结果」的记账
// 全是无副作用函数，便于单测；真正的发送在 daemon / electron 里。
// 设置页（渲染进程）也 import 本文件：不许引入带 node 依赖的模块（project-types / scheduled-task 等）。

import {
  resolveTaskNotify,
  taskImChannelId,
  type ScheduledTask,
  type TaskNotify,
} from "./scheduled-task-rules.js";

export const TASK_RESULT_TOOL = "send_result";

/** 文案里需要的名字查询（调用方各自从自己那份配置里取） */
export interface TaskDeliveryLabels {
  /** 通道显示名；找不到时返回 undefined */
  channelName(channelId?: string): string | undefined;
  /** 项目名；项目不存在返回 undefined */
  projectName(projectId: string): string | undefined;
}

// ── 目标描述 ───────────────────────────────────────────

/** 「Agent 会话」目标的显示名：空 = 所属通道的主会话 */
export function taskAgentTargetLabel(
  task: Pick<ScheduledTask, "targetProjectId">,
  labels: Pick<TaskDeliveryLabels, "projectName">,
): string {
  const pid = task.targetProjectId?.trim();
  if (!pid) return "主会话";
  const name = labels.projectName(pid);
  return name ? `项目「${name}」的会话` : "项目（已不存在）的会话";
}

/** 「IM」目标的显示名：通过哪个通道，发到哪个聊天 */
export function taskImTargetLabel(
  task: Pick<ScheduledTask, "channelId" | "notifyChannelId" | "notifyChatId">,
  labels: Pick<TaskDeliveryLabels, "channelName">,
): string {
  const channelId = taskImChannelId(task);
  const channel = channelId ? (labels.channelName(channelId) ?? "（通道已不存在）") : "（未选通道）";
  const chat = task.notifyChatId?.trim();
  const where = chat ? `聊天 ${shortChatId(chat)}` : "主用户私聊";
  return `通过「${channel}」发到${where}`;
}

function shortChatId(raw: string): string {
  const id = raw.includes("|") ? raw.slice(raw.indexOf("|") + 1) : raw;
  return id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
}

/** 设置页里一句话说清「这个任务怎么跑、结果去哪」 */
export function describeTaskDelivery(
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId">,
  labels: TaskDeliveryLabels,
): string {
  if (task.independent === false) {
    return `触发时把任务内容发给「${taskAgentTargetLabel(task, labels)}」，由它自己执行；会占用该会话的上下文。`;
  }
  const base = "每次由全新 Agent 执行，不占用任何会话上下文。";
  switch (resolveTaskNotify(task)) {
    case "agent":
      return `${base}完成后 AI 提交的结果会作为一条消息投进「${taskAgentTargetLabel(task, labels)}」的队列，并唤醒它处理。`;
    case "im":
      return `${base}完成后 AI 提交的结果会${taskImTargetLabel(task, labels)}，和 Agent 会话无关。`;
    default:
      return `${base}不通知：结果不会发给任何人（AI 仍可自己发图片 / 文件到所属通道的主用户私聊）。`;
  }
}

// ── 对话里 AI 用 manage_tasks 建 / 改任务：所属通道怎么选、去向怎么告诉它 ──

/**
 * AI 新建任务时没法指定通道，所属通道按「显式指定 > 调用者自己所在的通道 > 第一个通道」取。
 * 不能直接取第一个通道：多通道时它多半不是用户正在用的那个，
 * 非独立任务又是投给「所属通道的主会话」，结果任务悄悄投进了别的通道（比如飞书私聊）。
 */
export function chooseNewTaskChannel(opts: {
  explicit?: string;
  /** 调用者会话所在的通道 id */
  invokerChannelId?: string;
  /** 现有通道 id，按设置里的顺序 */
  channelIds: readonly string[];
}): string | undefined {
  const explicit = opts.explicit?.trim();
  if (explicit) return explicit;
  const invoker = opts.invokerChannelId?.trim();
  if (invoker && opts.channelIds.includes(invoker)) return invoker;
  return opts.channelIds[0];
}

/** 任务实际会去的位置（daemon 解析后传进来，本文件只管措辞） */
export interface ManagedTaskPlacement {
  /** 所属通道的显示名；通道不存在为 undefined */
  channelName?: string;
  /** 所属通道的类型名：飞书 / 微信 / 应用内对话 */
  channelKind?: string;
  /** 所属通道是飞书 / 微信这类外部 IM：投进它的主会话，回复会发到 IM 里 */
  channelIsExternalIm?: boolean;
  /**
   * 「投主会话」时解析出的会话：
   *  - undefined = 这个任务不是投主会话（独立且不通知到 Agent，或绑了项目），不需要说明
   *  - null = 想投主会话，但没解析出来（通道没有主用户 / 没配工作目录）
   *  - 字符串 = 解析出的会话 key
   */
  mainSessionKey?: string | null;
  /** 解析出的主会话是不是调用者当前所在的会话；undefined = 不知道调用者是谁（不下结论） */
  mainSessionIsInvoker?: boolean;
}

/**
 * AI 用 manage_tasks 新建 / 修改 / 启用任务后，工具返回里写明「这个任务实际会去哪」。
 * 只写「已创建」，AI 就会凭 independent=false 自己编出「在当前会话中运行」——实际投给的是所属通道的主会话。
 */
export function describeManagedTaskOutcome(
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId">,
  labels: TaskDeliveryLabels,
  placement: ManagedTaskPlacement,
): string {
  const channel = placement.channelName
    ? `「${placement.channelName}」${placement.channelKind ? `（${placement.channelKind}）` : ""}`
    : "（通道已不存在）";
  const lines = [`所属通道：${channel}`, `去向：${describeTaskDelivery(task, labels)}`];

  if (placement.mainSessionKey === null) {
    lines.push("⚠ 没能解析出这个通道的主会话（通道没有主用户私聊，或没配置工作目录），到点会投递失败。");
  } else if (placement.mainSessionKey !== undefined && placement.mainSessionIsInvoker !== undefined) {
    if (placement.mainSessionIsInvoker) {
      lines.push("这个主会话就是你当前所在的会话。");
    } else {
      lines.push(
        `⚠ 这个主会话不是你当前所在的会话${placement.channelIsExternalIm ? `，它的回复会发到${placement.channelKind ?? "IM"}里` : ""}。` +
        "如果用户要的是「当前会话」自己到点做事 / 过一阵回来看，请删除这个任务，改用 schedule_create（它绑定调用者所在的会话）。",
      );
    }
  }
  return lines.join("\n");
}

/** 设置页里 AI 排程的进度：已触发几次、什么时候过期 */
export function describeAiTaskProgress(
  task: Pick<ScheduledTask, "maxRuns" | "expiresAt" | "runCount">,
  now: number = Date.now(),
): string {
  const runs = task.runCount ?? 0;
  const progress = task.maxRuns !== undefined ? `已触发 ${runs}/${task.maxRuns} 次` : `已触发 ${runs} 次`;
  if (task.expiresAt === undefined) return progress;
  return task.expiresAt <= now ? `${progress}，已过期` : `${progress}，${stamp(new Date(task.expiresAt))} 过期`;
}

// ── 校验 / 保存前清理 ──────────────────────────────────

export interface TaskDeliveryCheckEnv {
  projectExists(projectId: string): boolean;
  channelExists(channelId: string): boolean;
  /** 通道是否已绑定主用户私聊；通道不存在时返回 undefined */
  channelMainUserBound(channelId: string): boolean | undefined;
  channelName(channelId: string): string | undefined;
}

/** 保存前检查「结果能不能送达」；返回错误说明，没问题返回 undefined */
export function validateTaskDelivery(
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId">,
  env: TaskDeliveryCheckEnv,
): string | undefined {
  const projectId = task.targetProjectId?.trim();
  const mode = resolveTaskNotify(task);
  const needsProject = task.independent === false || mode === "agent";
  if (needsProject && projectId && !env.projectExists(projectId)) {
    return "绑定的项目已不存在，请重新选择 Agent 会话";
  }
  if (mode === "im") {
    const channelId = taskImChannelId(task);
    if (!channelId) return "请选择发送结果的消息通道";
    if (!env.channelExists(channelId)) return "发送通道已不存在，请重新选择";
    if (!task.notifyChatId?.trim() && env.channelMainUserBound(channelId) !== true) {
      const name = env.channelName(channelId) ?? channelId;
      return `通道「${name}」还没有绑定主用户私聊：请填写飞书群 / 聊天 ID，或先在通道设置里绑定主用户`;
    }
  }
  return undefined;
}

/**
 * 保存前把「当前方式用不到的字段」清掉，并把推断出来的通知方式写实：
 * 不清的话，切换方式后残留的聊天 ID / 项目绑定会在不该生效的地方悄悄生效。
 */
export function normalizeTaskDelivery<T extends ScheduledTask>(task: T): T {
  const next: T = { ...task };
  if (next.independent === false) {
    delete next.notify;
    delete next.notifyChannelId;
    delete next.notifyChatId;
    if (!next.targetProjectId?.trim()) delete next.targetProjectId;
    return next;
  }
  const mode = resolveTaskNotify(next);
  next.notify = mode;
  if (mode !== "im") {
    delete next.notifyChatId;
    delete next.notifyChannelId;
  } else {
    if (!next.notifyChatId?.trim()) delete next.notifyChatId;
    // 和所属通道一样就不用单独存：之后改所属通道，发送通道自然跟着走
    if (!next.notifyChannelId?.trim() || next.notifyChannelId.trim() === next.channelId?.trim()) {
      delete next.notifyChannelId;
    }
  }
  if (mode !== "agent" || !next.targetProjectId?.trim()) delete next.targetProjectId;
  return next;
}

// ── 消息文案 ───────────────────────────────────────────

function stamp(now: Date): string {
  return now.toLocaleString("zh-CN", { hour12: false });
}

/** 投进 Agent 会话队列的结果消息：一行标题标明来源，正文原样 */
export function formatTaskResultForAgent(
  task: Pick<ScheduledTask, "name" | "createdBy">,
  text: string,
  now: Date = new Date(),
): string {
  return `⏰ 定时任务「${task.name}」汇报（${stamp(now)}）\n\n${text.trim()}`;
}

/** AI 自排程（session 模式）：到点提醒自己做某事，内容是 AI 当初自己写下的 */
export function formatAiSelfReminder(
  task: Pick<ScheduledTask, "name">,
  prompt: string,
  progress: { run: number; maxRuns?: number },
  now: Date = new Date(),
): string {
  const n = progress.maxRuns ? `第 ${progress.run}/${progress.maxRuns} 次` : `第 ${progress.run} 次`;
  return `⏰ 定时任务「${task.name}」（${stamp(now)}，${n}）\n\n${prompt}`;
}

/** 发到 IM 的结果：带上任务名，收到的人才知道是哪个任务 */
export function formatTaskImResult(task: Pick<ScheduledTask, "name">, text: string): string {
  return `⏰ **${task.name}**\n\n${text.trim()}`;
}

/** AI 没提交结果时发给接收方的一句话（只在通知到 IM 时发） */
export function taskMissingResultText(task: Pick<ScheduledTask, "name">): string {
  return `⏰ **${task.name}** 已运行结束，但没有提交结果。`;
}

/**
 * 跑完却没提交结果，要不要给接收方发 {@link taskMissingResultText}。
 * 只有 IM：那里有人等着看结果，什么都没收到就分不清是「没事」还是「没跑成」。
 * 通知到 Agent 的任务多是盯进度 / 查缺陷，没事就不用汇报；兜底提示会白白唤醒目标会话、让它在聊天里回一句废话。
 */
export function shouldNoticeMissingResult(task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId">): boolean {
  return resolveTaskNotify(task) === "im";
}

// ── 独立任务会话的提示词 ───────────────────────────────

/**
 * 独立运行的任务会话附加的协议段：一句话说清「回复不直接送达、做完用 send_result 交结果」，
 * 再按通知方式说清结果去哪。非独立任务（内容进已有会话）不需要。
 */
export function buildTaskProtocolSection(
  task: Pick<ScheduledTask, "name" | "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId">,
  labels: TaskDeliveryLabels,
): string {
  if (task.independent === false) return "";
  const mode: TaskNotify = resolveTaskNotify(task);
  const lines = [
    `## 定时任务「${task.name}」`,
    "",
    mode === "agent"
      ? `独立运行：你的回复不会直接发给任何人。有要汇报的调用 \`${TASK_RESULT_TOOL}\` 提交（\`text\` 是结果正文）；没有就直接结束。`
      : `独立运行：你的回复不会直接发给任何人，做完后调用 \`${TASK_RESULT_TOOL}\` 提交结果（\`text\` 是结果正文；没什么要汇报的传 \`quiet=true\`）。`,
  ];
  if (mode === "im") {
    lines.push(`结果会${taskImTargetLabel(task, labels)}。图片 / 文件可用 \`send_image\` / \`send_file\` 发到同一处。`);
  } else if (mode === "agent") {
    lines.push(`结果会投进「${taskAgentTargetLabel(task, labels)}」。图片 / 文件发不过去，路径写在 \`text\` 里。`);
  } else {
    lines.push(`结果只做记录、不发送。图片 / 文件可用 \`send_image\` / \`send_file\` 发到主用户私聊。`);
  }
  return lines.join("\n");
}

// ── 「这次运行有没有提交结果」记账 ────────────────────

export type TaskRunOutcome = "submitted" | "quiet" | "missing";

interface RunState {
  /** 本批次里最早一条任务消息入队的时间 */
  queuedAt?: number;
  result?: { at: number; quiet: boolean };
}

/**
 * 一次运行 = 从任务消息入队，到这批消息被确认处理完。
 * 运行里 AI 调了 send_result 就记一笔；确认时对账：提交了 / 声明没事可报 / 什么都没提交。
 * 内存记账：daemon 重启后没有入队记录，对不上的一律不判（宁可漏提示，也不误报「AI 没提交」）。
 */
export class TaskRunTracker {
  private readonly runs = new Map<string, RunState>();

  /** 一条任务消息入队 */
  queued(taskId: string, at: number = Date.now()): void {
    const s = this.runs.get(taskId) ?? {};
    if (s.queuedAt === undefined) s.queuedAt = at;
    this.runs.set(taskId, s);
  }

  /** 有一轮运行在记账中（已入队、还没确认处理完）；清理 AI 排程前用它确认没有在跑 */
  isActive(taskId: string): boolean {
    const s = this.runs.get(taskId);
    return s?.queuedAt !== undefined;
  }

  /** 这一轮是否已经提交过结果（用于拒绝重复提交） */
  alreadySubmitted(taskId: string): boolean {
    const s = this.runs.get(taskId);
    return !!s?.result && s.queuedAt !== undefined && s.result.at >= s.queuedAt;
  }

  /** AI 提交了结果（quiet = 声明没事可报） */
  submitted(taskId: string, quiet: boolean, at: number = Date.now()): void {
    const s = this.runs.get(taskId) ?? {};
    s.result = { at, quiet };
    this.runs.set(taskId, s);
  }

  /**
   * 一批任务消息处理完。hasPending = 队列里还有等着处理的任务消息，
   * 这时把窗口让给下一轮（下一轮的 queuedAt 从现在算起）。
   * 返回 undefined 表示没有这一轮的入队记录，不判。
   */
  finished(taskId: string, hasPending: boolean, at: number = Date.now()): TaskRunOutcome | undefined {
    const s = this.runs.get(taskId);
    this.runs.delete(taskId);
    if (hasPending) this.runs.set(taskId, { queuedAt: at });
    if (!s || s.queuedAt === undefined) return undefined;
    const r = s.result;
    if (!r || r.at < s.queuedAt) return "missing";
    return r.quiet ? "quiet" : "submitted";
  }
}

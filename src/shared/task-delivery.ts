// ── 定时任务「结果交付」的纯逻辑 ─────────────────────────
// 通知谁（不通知 / 通知 AI / 通知我）涉及：
//   - 设置页的文案、校验、保存前清理（renderer 用）
//   - 独立任务会话的提示词（告诉 AI 怎么用 send_result）
//   - daemon 把结果投到哪、投成什么样（Agent 队列消息 / IM 卡片 / 应用内会话消息）
//   - 「这次运行有没有提交结果」的记账
// 全是无副作用函数，便于单测；真正的发送在 daemon / electron 里。
// 设置页（渲染进程）也 import 本文件：不许引入带 node 依赖的模块（project-types / scheduled-task 等）。

import { channelIdFromSessionKey } from "./channel-types.js";
import {
  isAiTask,
  resolveTaskNotify,
  taskAgentSessionKey,
  taskNotifyChannelId,
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
  /** 是不是应用内对话通道：它没有「主用户私聊」，要选具体会话 */
  isAppChannel(channelId?: string): boolean;
  /** 会话在界面上的名字；认不出（或调用方列不出会话名）返回 undefined */
  sessionName?(sessionKey: string): string | undefined;
}

// ── 目标描述 ───────────────────────────────────────────

/**
 * 「通知 AI」目标的显示名：绑了项目 = 该项目的会话；选了具体会话 = 那个会话；
 * AI 自己排的程 = 创建它的会话（可能是主会话，也可能是应用内的其他会话）；其余 = 通道的主会话。
 */
export function taskAgentTargetLabel(
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "targetProjectId" | "createdBy">,
  labels: Pick<TaskDeliveryLabels, "projectName" | "sessionName">,
): string {
  const pid = task.targetProjectId?.trim();
  if (pid) {
    const name = labels.projectName(pid);
    return name ? `项目「${name}」的会话` : "项目（已不存在）的会话";
  }
  const session = taskAgentSessionKey(task);
  if (session) {
    const name = labels.sessionName?.(session);
    return name ? `会话「${name}」` : "所选会话";
  }
  return task.createdBy === "ai" ? "创建它的会话" : "主会话";
}

/**
 * 「通知我」目标的显示名：通过哪个通道，发到哪个聊天 / 会话。
 * 应用内通道每个任务一个专属会话（没有就在第一次投递时建），不让用户挑，所以不写会话名。
 */
export function taskUserTargetLabel(
  task: Pick<ScheduledTask, "channelId" | "notifyChannelId" | "notifyChatId">,
  labels: Pick<TaskDeliveryLabels, "channelName" | "isAppChannel">,
): string {
  const channelId = taskNotifyChannelId(task);
  const channel = channelId ? (labels.channelName(channelId) ?? "（通道已不存在）") : "（未选通道）";
  if (labels.isAppChannel(channelId)) return `通过「${channel}」发到这个任务专属的会话（没有就自动创建）`;
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
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId" | "createdBy">,
  labels: TaskDeliveryLabels,
): string {
  const mode = resolveTaskNotify(task);
  if (task.independent === false) {
    return mode === "im"
      ? `触发时不启动 Agent，直接把任务内容以 AI 口吻${taskUserTargetLabel(task, labels)}。`
      : `触发时把任务内容发给「${taskAgentTargetLabel(task, labels)}」，由它自己执行；会占用该会话的上下文。`;
  }
  const base = "每次由全新 Agent 执行，不占用任何会话上下文。";
  switch (mode) {
    case "agent":
      return `${base}完成后 AI 提交的结果会作为一条消息投进「${taskAgentTargetLabel(task, labels)}」的队列，并唤醒它处理；没提交结果就不通知。`;
    case "im":
      return `${base}完成后 AI 提交的结果会以 AI 口吻${taskUserTargetLabel(task, labels)}，不唤醒任何 Agent；没提交结果就不通知。`;
    default:
      return `${base}不通知：结果不会发给任何人（AI 仍可自己发图片 / 文件到通道的主用户私聊）。`;
  }
}

// ── 对话里 AI 用 manage_tasks 建 / 改任务：通道怎么选、去向怎么告诉它 ──

/**
 * AI 新建任务时没法指定通道，通道按「显式指定 > 调用者自己所在的通道 > 第一个通道」取。
 * 不能直接取第一个通道：多通道时它多半不是用户正在用的那个，
 * 通知 AI 又是投给「通道的主会话」，结果任务悄悄投进了别的通道（比如飞书私聊）。
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
  /** 通道的显示名；通道不存在为 undefined */
  channelName?: string;
  /** 通道的类型名：飞书 / 微信 / 应用内对话 */
  channelKind?: string;
  /** 通道是飞书 / 微信这类外部 IM：投进它的主会话，回复会发到 IM 里 */
  channelIsExternalIm?: boolean;
  /**
   * 「投会话」（通道主会话 / 所选的具体会话）时解析出的会话：
   *  - undefined = 这个任务不投会话（不通知 AI，或绑了项目），不需要说明
   *  - null = 想投会话，但没解析出来（主会话：通道没有主用户 / 没配工作目录；所选会话：已被删除 / 不属于这个通道）
   *  - 字符串 = 解析出的会话 key
   */
  mainSessionKey?: string | null;
  /** 解析出的会话是不是调用者当前所在的会话；undefined = 不知道调用者是谁（不下结论） */
  mainSessionIsInvoker?: boolean;
}

/**
 * AI 用 manage_tasks 新建 / 修改 / 启用任务后，工具返回里写明「这个任务实际会去哪」。
 * 只写「已创建」，AI 就会凭 independent=false 自己编出「在当前会话中运行」——实际投给的是通道的主会话。
 */
export function describeManagedTaskOutcome(
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId" | "createdBy">,
  labels: TaskDeliveryLabels,
  placement: ManagedTaskPlacement,
): string {
  const channel = placement.channelName
    ? `「${placement.channelName}」${placement.channelKind ? `（${placement.channelKind}）` : ""}`
    : "（通道已不存在）";
  const lines = [`通道：${channel}`, `去向：${describeTaskDelivery(task, labels)}`];

  // 选了具体会话（含 AI 默认选的「它自己所在的会话」）和通道主会话，措辞不同
  const picked = !!taskAgentSessionKey(task);
  const subject = picked ? "所选会话" : "这个主会话";
  if (placement.mainSessionKey === null) {
    lines.push(
      picked
        ? "⚠ 没能找到所选会话（已被删除，或不属于这个通道），到点会投递失败。"
        : "⚠ 没能解析出这个通道的主会话（通道没有主用户私聊，或没配置工作目录），到点会投递失败。",
    );
  } else if (placement.mainSessionKey !== undefined && placement.mainSessionIsInvoker !== undefined) {
    if (placement.mainSessionIsInvoker) {
      lines.push(`${subject}就是你当前所在的会话。`);
    } else {
      lines.push(
        `⚠ ${subject}不是你当前所在的会话${placement.channelIsExternalIm ? `，它的回复会发到${placement.channelKind ?? "IM"}里` : ""}。` +
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
  /** 是不是应用内对话通道 */
  channelIsApp(channelId: string): boolean;
}

/** 保存前检查「结果能不能送达」；返回错误说明，没问题返回 undefined */
export function validateTaskDelivery(
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId">,
  env: TaskDeliveryCheckEnv,
): string | undefined {
  const mode = resolveTaskNotify(task);
  if (mode === "none") return undefined;

  const projectId = task.targetProjectId?.trim();
  if (mode === "agent" && projectId && !env.projectExists(projectId)) {
    return "绑定的项目已不存在，请重新选择 Agent 会话";
  }
  const channelId = taskNotifyChannelId(task);
  if (!channelId) return "请选择通知的通道";
  if (!env.channelExists(channelId)) return "通知的通道已不存在，请重新选择";

  const chat = task.notifyChatId?.trim();
  const isApp = env.channelIsApp(channelId);
  // 应用内通道的「通知我」不挑会话：每个任务有自己的专属会话，缺了 / 不属于这个通道就在投递时重建，所以这里不拦
  const sessionKey = mode === "agent" ? taskAgentSessionKey(task) : undefined;
  if (sessionKey && channelIdFromSessionKey(sessionKey) !== channelId) return "所选会话不属于这个通道，请重新选择";
  if (mode === "im" && !chat && !isApp) {
    if (env.channelMainUserBound(channelId) !== true) {
      const name = env.channelName(channelId) ?? channelId;
      return `通道「${name}」还没有绑定主用户私聊：请填写飞书群 / 聊天 ID，或先在通道设置里绑定主用户`;
    }
  }
  return undefined;
}

/**
 * 保存前把「当前方式用不到的字段」清掉，并把推断出来的通知方式写实：
 * 不清的话，切换方式后残留的聊天 ID / 项目绑定 / 模型会在不该生效的地方悄悄生效。
 */
export function normalizeTaskDelivery<T extends ScheduledTask>(task: T): T {
  const next: T = { ...task };
  const mode = resolveTaskNotify(next);
  next.notify = mode;
  // 模型只属于独立运行：非独立运行的内容进别人的会话，用的是那个会话自己的模型
  if (next.independent === false) {
    delete next.model;
    delete next.modelParams;
    delete next.resourceId;
  }
  if (mode === "none") {
    delete next.notifyChatId;
    delete next.notifyChannelId;
    delete next.targetProjectId;
    return next;
  }
  if (!next.notifyChatId?.trim()) delete next.notifyChatId;
  // 项目会话和具体会话二选一：绑了项目，会话键就是残留
  if (mode === "agent" && next.targetProjectId?.trim()) delete next.notifyChatId;
  if (mode !== "agent" || !next.targetProjectId?.trim()) delete next.targetProjectId;
  // 和通道一样就不用单独存：之后改通道，通知通道自然跟着走
  if (!next.notifyChannelId?.trim() || next.notifyChannelId.trim() === next.channelId?.trim()) {
    delete next.notifyChannelId;
  }
  return next;
}

// ── 用户建的任务只有一种交付方式：独立运行 + 通知我 ──────────────

/**
 * 存着的任务是不是旧版的交付方式（非独立运行 / 不通知 / 通知 AI / 绑了项目）。
 * 这些任务照存的字段继续跑，设置页打开时提示一句，保存才会转成「独立运行 + 通知我」。
 */
export function isLegacyDelivery(
  task: Pick<ScheduledTask, "independent" | "notify" | "notifyChatId" | "targetProjectId">,
): boolean {
  return task.independent === false || resolveTaskNotify(task) !== "im" || !!task.targetProjectId?.trim();
}

/**
 * 设置页保存 / manage_tasks 新建时把任务定成「独立运行 + 通知我」，其余交付字段一并清理。
 * 原来不是「通知我」的（通知 AI 的会话键、不通知残留的聊天 ID）对通知我没有意义，不带过来。
 */
export function toUserNotifyTask<T extends ScheduledTask>(task: T): T {
  const next: T = { ...task, independent: true, notify: "im" };
  if (resolveTaskNotify(task) !== "im") delete next.notifyChatId;
  delete next.targetProjectId;
  return normalizeTaskDelivery(next);
}

/**
 * 设置页保存时界面里的任务快照可能比 daemon 落盘的旧：daemon 在应用内通道为任务新建专属会话后，
 * 把会话键写回了文件，快照里没有它。以文件里的为准把它带回来，否则每保存一次，下次运行就重建一个会话。
 * 只带回应用内会话键（含 ::，飞书群 ID 没有）；通知通道换过的不带，旧通道的会话键对新通道没用。
 */
export function keepTaskAppSessions<T extends ScheduledTask>(saved: readonly T[], before: readonly T[]): T[] {
  const old = new Map(before.map((t) => [t.id, t]));
  return saved.map((t) => {
    if (isAiTask(t) || t.notifyChatId?.trim() || resolveTaskNotify(t) !== "im") return t;
    const prev = old.get(t.id);
    const key = prev?.notifyChatId?.trim();
    if (!prev || !key?.includes("::") || taskNotifyChannelId(prev) !== taskNotifyChannelId(t)) return t;
    return { ...t, notifyChatId: key };
  });
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

/**
 * 发给用户的任务消息，同一条消息的两种写法：
 *  - text：正文第一行带任务名（⏰ **任务名**）。微信、应用内、飞书群聊这些没有任务横幅的地方用这份，收到的人才知道是哪个任务；
 *  - titledText：不带任务名。飞书主用户私聊的卡片横幅已经是「⏰ 任务名」，再带一遍就重复了。
 * 用哪份由发送处看横幅有没有真的显示来定（daemon 的 resolveSendCardText），这里只负责把两份写对。
 */
export function formatTaskImMessage(
  task: Pick<ScheduledTask, "name">,
  text: string,
): { text: string; titledText: string } {
  const bare = text.trim();
  return { text: `⏰ **${task.name}**\n\n${bare}`, titledText: bare };
}

/** 发给用户的结果：带上任务名，收到的人才知道是哪个任务 */
export function formatTaskImResult(task: Pick<ScheduledTask, "name">, text: string): string {
  return formatTaskImMessage(task, text).text;
}

// ── 独立任务会话的提示词 ───────────────────────────────

/**
 * 独立运行的任务会话附加的协议段：一句话说清「回复不直接送达、做完用 send_result 交结果」，
 * 再按通知方式说清结果去哪。非独立任务（内容进已有会话）不需要。
 */
export function buildTaskProtocolSection(
  task: Pick<ScheduledTask, "name" | "independent" | "notify" | "notifyChatId" | "channelId" | "notifyChannelId" | "targetProjectId" | "createdBy">,
  labels: TaskDeliveryLabels,
): string {
  if (task.independent === false) return "";
  const mode: TaskNotify = resolveTaskNotify(task);
  const lines = [
    `# 定时任务「${task.name}」`,
    "",
    mode === "none"
      ? `独立运行：你的回复不会直接发给任何人，做完后调用 \`${TASK_RESULT_TOOL}\` 提交结果（\`text\` 是结果正文；没什么要汇报的传 \`quiet=true\`）。`
      : `独立运行：你的回复不会直接发给任何人。有要汇报的调用 \`${TASK_RESULT_TOOL}\` 提交（\`text\` 是结果正文）；没有就直接结束。`,
  ];
  if (mode === "im") {
    lines.push(`结果会${taskUserTargetLabel(task, labels)}。图片 / 文件可用 \`send_image\` / \`send_file\` 发到同一处。`);
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

  /**
   * 一条任务消息入队。queueWasIdle = 入队前这个任务的会话队列里没有排队 / 处理中的消息：
   * 上一轮要么已对账收口，要么被清空队列、重置、删会话这类外力打断（不会走到「确认处理完」），
   * 这一条开启新一轮，残留的记账一律作废；否则并入正在进行的这一批。
   */
  queued(taskId: string, queueWasIdle: boolean, at: number = Date.now()): void {
    const s = queueWasIdle ? {} : (this.runs.get(taskId) ?? {});
    if (s.queuedAt === undefined) s.queuedAt = at;
    this.runs.set(taskId, s);
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

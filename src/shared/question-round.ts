// ── 点选提问的「一轮」──────────────────────────────────────────────────
// 一轮 = Agent 从领取一批消息到这一批处理完（daemon 确认已处理）之间干的活。每道题记下自己是哪一轮问的：
//   · 这一轮结束之前：用户点选只记下答案，不交给 Agent；用户打字也不会把这道题关掉
//     （他可能还没看到这一轮后面发的题）。
//   · 这一轮结束之后：这一轮的题都选完就交给 Agent；用户再打字，没选的题才算被他的文字代替而关闭。
// 轮的编号只在内存里。daemon 重启后，存盘的题记着的旧编号都对不上当前这一轮，一律算已结束。
//
// 一轮只有一个发言人（投递按发言人分批，见 file-queue）。每道题还记下自己归哪个发言人：
// 只有他本人和管理员能点这道题、他打字才算代替了这道题。群里别人的点击和打字不碰它。

import { randomUUID } from "node:crypto";
import { normalizeSessionKey } from "./channel-types.js";

export class QuestionRounds {
  private readonly active = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly questionCounts = new Map<string, number>();

  private key(sessionKey: string): string {
    return normalizeSessionKey(sessionKey) || sessionKey;
  }

  /** 会话当前这一轮的编号（还没有就开一轮）：发题时记在题目上 */
  current(sessionKey: string): string {
    const key = this.key(sessionKey);
    let id = this.active.get(key);
    if (!id) {
      id = randomUUID();
      this.active.set(key, id);
    }
    return id;
  }

  /** Agent 领到一批消息：记下这一批的发言人，这一轮问的题归他；整批都没有发言人（系统消息、定时任务）就清掉 */
  setOwner(sessionKey: string, owner: string | undefined): void {
    const key = this.key(sessionKey);
    if (owner) this.owners.set(key, owner);
    else this.owners.delete(key);
  }

  /** 这一轮问的题归谁：发题时记在题目上 */
  owner(sessionKey: string): string | undefined {
    return this.owners.get(this.key(sessionKey));
  }

  /** 这一轮里下一道题的题号（从 1 起）：发题时告诉 Agent，它凭题号指定要撤回哪道题 */
  nextQuestionNo(sessionKey: string): number {
    this.current(sessionKey);
    const key = this.key(sessionKey);
    const no = (this.questionCounts.get(key) ?? 0) + 1;
    this.questionCounts.set(key, no);
    return no;
  }

  /** 这一轮结束了（这一批消息已确认处理完）：这一轮问的题此后都算已结束 */
  end(sessionKey: string): void {
    const key = this.key(sessionKey);
    this.active.delete(key);
    this.questionCounts.delete(key);
  }

  /** 题目所属的那一轮是否已结束。没记轮次（旧版本存下的题）或不是当前这一轮，都算已结束 */
  isEnded(sessionKey: string, round: string | undefined): boolean {
    return !round || this.active.get(this.key(sessionKey)) !== round;
  }
}

/**
 * 这个人能不能替这道题作答（点它、或者打字代替它）：归属人本人，或管理员。
 * 没有归属人的题（系统消息、定时任务问的、旧版本存下的）谁都可以；认不出是谁（回调没带点击人）也不拦。
 */
export function mayAnswerQuestion(owner: string | undefined, who: string | undefined, isAdmin: boolean): boolean {
  return !owner || !who || who === owner || isAdmin;
}

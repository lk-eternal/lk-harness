// ── 点选提问的「一轮」──────────────────────────────────────────────────
// 一轮 = Agent 从领取消息到下一次进入等待之间干的活。每道题记下自己是哪一轮问的：
//   · 这一轮结束之前：用户点选只记下答案，不交给 Agent；用户打字也不会把这道题关掉
//     （他可能还没看到这一轮后面发的题）。
//   · 这一轮结束之后：这一轮的题都选完就交给 Agent；用户再打字，没选的题才算被他的文字代替而关闭。
// 轮的编号只在内存里。daemon 重启后，存盘的题记着的旧编号都对不上当前这一轮，一律算已结束。

import { randomUUID } from "node:crypto";
import { normalizeSessionKey } from "./channel-types.js";

export class QuestionRounds {
  private readonly active = new Map<string, string>();

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

  /** 这一轮结束了（Agent 进入等待）：这一轮问的题此后都算已结束 */
  end(sessionKey: string): void {
    this.active.delete(this.key(sessionKey));
  }

  /** 题目所属的那一轮是否已结束。没记轮次（旧版本存下的题）或不是当前这一轮，都算已结束 */
  isEnded(sessionKey: string, round: string | undefined): boolean {
    return !round || this.active.get(this.key(sessionKey)) !== round;
  }
}

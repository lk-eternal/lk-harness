import { describe, expect, it } from "vitest";
import { LarkSender } from "../src/shared/lark-core.js";

describe("LarkSender @ mention helpers", () => {
  it("extractAtTags skips code blocks", () => {
    const text = "请 <at user_id=\"ou_abc\">Alice</at> 协助\n```\n<at user_id=\"ou_fake\">Bob</at>\n```";
    expect(LarkSender.extractAtTags(text)).toEqual(['<at user_id="ou_abc">Alice</at>']);
  });

  it("stripAtTagsForCardDisplay replaces tags with readable names", () => {
    const text = "结论如下，<at user_id=\"ou_abc\">Alice</at> 请确认";
    expect(LarkSender.stripAtTagsForCardDisplay(text)).toBe("结论如下，@Alice 请确认");
  });

  it("containsAtTag ignores at syntax inside inline code", () => {
    expect(LarkSender.containsAtTag("用法：`<at user_id=\"ou_x\">`")).toBe(false);
    expect(LarkSender.containsAtTag("<at user_id=\"ou_x\">Bot</at>")).toBe(true);
  });
});

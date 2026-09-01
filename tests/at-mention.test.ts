import { describe, expect, it } from "vitest";
import { LarkSender } from "../src/shared/lark-core.js";

describe("LarkSender @ mention helpers", () => {
  it("extractAtTags skips code blocks", () => {
    const text = "? <at user_id=\"ou_abc\">Alice</at> ??\n```\n<at user_id=\"ou_fake\">Bob</at>\n```";
    expect(LarkSender.extractAtTags(text)).toEqual(['<at user_id="ou_abc">Alice</at>']);
  });

  it("stripAtTagsForCardDisplay replaces tags with readable names", () => {
    const text = "?????<at user_id=\"ou_abc\">Alice</at> ????";
    expect(LarkSender.stripAtTagsForCardDisplay(text)).toBe("?????@Alice ????");
  });

  it("containsAtTag ignores at syntax inside inline code", () => {
    expect(LarkSender.containsAtTag("???`<at user_id=\"ou_x\">`")).toBe(false);
    expect(LarkSender.containsAtTag("<at user_id=\"ou_x\">Bot</at>")).toBe(true);
  });
});

import { describe, expect, it } from "vitest"
import { maskSecretValue, redactDeep, redactText, redactedTail } from "../src/shared/redact"

describe("redactDeep：按键名遮凭据", () => {
  // 形状取自真实的 AppConfig / MessageChannel / AgentResource，凭据值都是编造的
  const config = {
    mobileToken: "mob-abcdef0123456789",
    mobilePort: 19600,
    mobilePublicUrl: "https://example.test/m",
    gitlabToken: "glpat-AAAAAAAAAAAAAAAAAAAA",
    flowHubToken: "fh-secret-value",
    httpProxy: "http://proxyuser:p%40ss@127.0.0.1:7890",
    httpsProxy: "",
    noProxy: "localhost,127.0.0.1",
    larkAppSecret: "legacy-secret-1234",
    cursorApiKey: "crsr_0123456789abcdef0123456789abcdef",
    agentResources: [
      { id: "sdk_1", name: "主 Key", apiKey: "sk-live-0123456789abcdef", baseUrl: "https://gw.example.test/v1" },
      { id: "llm_2", name: "无 Key", apiKey: "" },
    ],
    channels: [
      { id: "ch_1", name: "飞书", larkAppId: "cli_abc", larkAppSecret: "feishu-secret-xyz", wechatToken: "wx-token-1", enabled: true },
    ],
    usage: { maxTokens: 4096, inputTokens: 12 },
  }
  const out = redactDeep(config) as typeof config

  it("点名之外的凭据字段（以前会漏的）也遮掉", () => {
    expect(out.mobileToken).toBe(maskSecretValue(config.mobileToken))
    expect(out.gitlabToken).toBe(maskSecretValue(config.gitlabToken))
    expect(out.flowHubToken).toBe(maskSecretValue(config.flowHubToken))
    expect(out.larkAppSecret).toBe(maskSecretValue(config.larkAppSecret))
    expect(out.cursorApiKey).toBe(maskSecretValue(config.cursorApiKey))
  })

  it("嵌套数组里的凭据也遮；遮完保留长度、不保留任何原字符", () => {
    expect(out.agentResources[0].apiKey).toBe(`***(len=${config.agentResources[0].apiKey!.length})`)
    expect(out.channels[0].larkAppSecret).toBe(maskSecretValue("feishu-secret-xyz"))
    expect(out.channels[0].wechatToken).toBe(maskSecretValue("wx-token-1"))
    const json = JSON.stringify(out)
    for (const secret of ["mob-abcdef", "glpat-AAAA", "fh-secret", "legacy-secret", "crsr_0123", "sk-live", "feishu-secret", "wx-token"]) {
      expect(json).not.toContain(secret)
    }
  })

  it("空凭据保持为空（能看出「没配置」）", () => {
    expect(out.agentResources[1].apiKey).toBe("")
    expect(out.httpsProxy).toBe("")
  })

  it("代理地址里的账号口令被抹掉，主机端口保留", () => {
    expect(out.httpProxy).toBe("http://***@127.0.0.1:7890")
  })

  it("不相干的字段原样保留（数字、布尔、普通字符串、用量计数）", () => {
    expect(out.mobilePort).toBe(19600)
    expect(out.channels[0].enabled).toBe(true)
    expect(out.channels[0].larkAppId).toBe("cli_abc")
    expect(out.agentResources[0].baseUrl).toBe("https://gw.example.test/v1")
    expect(out.usage).toEqual({ maxTokens: 4096, inputTokens: 12 })
    expect(out.noProxy).toBe("localhost,127.0.0.1")
  })

  it("不改入参", () => {
    expect(config.mobileToken).toBe("mob-abcdef0123456789")
    expect(config.agentResources[0].apiKey).toBe("sk-live-0123456789abcdef")
  })

  it("以后新增的凭据字段默认也是安全的（不用回来改白名单）", () => {
    const next = redactDeep({ newServiceToken: "n3w-t0k3n-value", fooPassword: "hunter2hunter2", other: "x" })
    expect(next.newServiceToken).toMatch(/^\*\*\*/)
    expect(next.fooPassword).toMatch(/^\*\*\*/)
    expect(next.other).toBe("x")
  })

  it("sessionKey 是路由键不是口令，不能被误遮", () => {
    const v = redactDeep({ sessionKey: "ch_1|app_main::D:\\ws", session_key: "abc" })
    expect(v.sessionKey).toBe("ch_1|app_main::D:\\ws")
    expect(v.session_key).toBe("abc")
  })
})

describe("redactText：按模式遮日志文本", () => {
  it("Authorization / Bearer 头整段遮", () => {
    expect(redactText("Authorization: Bearer abcdefghijklmnop12345")).toBe("Authorization: Bearer ***")
    expect(redactText("req headers {authorization: 'Bearer abcdefghijklmnop12345'}")).not.toContain("abcdefghij")
    expect(redactText("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic ***")
  })

  it("key=value 与 JSON 的 \"key\":\"value\"，含被转义过的 JSON", () => {
    expect(redactText('token=abc123def456&foo=bar')).toBe("token=***&foo=bar")
    expect(redactText('{"app_secret":"S3cr3tValue99","name":"x"}')).toBe('{"app_secret":"***","name":"x"}')
    expect(redactText(String.raw`body="{\"access_token\":\"u-abcdefghijklmnopqrstuvwxyz0123\"}"`)).not.toContain("abcdefghijklmnop")
    expect(redactText("password: hunter2hunter2")).toBe("password: ***")
  })

  it("URL 里的账号口令与敏感查询参数", () => {
    expect(redactText("clone https://user:pw123@git.example.test/a/b.git")).toBe("clone https://***@git.example.test/a/b.git")
    expect(redactText("GET /download?ticket=Zm9vYmFy&name=a.apk")).toBe("GET /download?ticket=***&name=a.apk")
    expect(redactText("https://a.test/x?foo=1&access_token=zzzzzzzz")).toBe("https://a.test/x?foo=1&access_token=***")
  })

  it("Cookie 整行遮", () => {
    expect(redactText("Cookie: sid=abc; csrf=def; other=ghi")).toBe("Cookie: ***")
  })

  it("常见令牌形状：不依赖键名", () => {
    for (const t of [
      "sk-proj-abcdefghijklmnopqrstuvwx",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnop",
      "glpat-abcdefghijklmnopqrst",
      "t-g1048abcdefghijklmnopqrstuvwxyz0123",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij",
    ]) {
      expect(redactText(`got ${t} ok`)).toBe("got *** ok")
    }
  })

  it("路径里的系统用户名被抹掉（含 JSON 转义的反斜杠和正斜杠写法）", () => {
    expect(redactText("D:\\x C:\\Users\\lk547\\AppData\\Roaming\\app")).toBe("D:\\x C:\\Users\\<user>\\AppData\\Roaming\\app")
    expect(redactText("C:\\\\Users\\\\lk547\\\\a")).toBe("C:\\\\Users\\\\<user>\\\\a")
    expect(redactText("C:/Users/lk547/a")).toBe("C:/Users/<user>/a")
    expect(redactText("/Users/lk/Library/x /home/lk/.cache")).toBe("/Users/<user>/Library/x /home/<user>/.cache")
  })

  it("不误伤：没有凭据的日志行逐字不变", () => {
    const lines = [
      "[INFO] session=ch_1|app_main::D:\\ws started",
      "sessionKey=ch_1|app_main::D:\\ws queued=3",
      "usage tokens=1234 max_tokens: 4096 cacheReadTokens=0",
      "[StreamCard] 面板展开态 panel=r3 open=true msg=om_abc",
      "卡片按钮点击: msg=om_x value={\"kind\":\"question\",\"opt\":\"是\"}",
      "http://127.0.0.1:19528/api/poll-message?sessionKey=abc&wait=false",
      "download done in 3.2s, 171738050 bytes",
    ]
    for (const l of lines) expect(redactText(l)).toBe(l)
  })

  it("幂等：脱敏两次等于脱敏一次", () => {
    const s = 'Authorization: Bearer abcdefghijklmnop12345 token=abc123def456 https://u:p@h.test/x?ticket=zzz C:\\Users\\lk547\\a'
    const once = redactText(s)
    expect(redactText(once)).toBe(once)
  })

  it("空串与无关输入", () => {
    expect(redactText("")).toBe("")
  })
})

describe("redactedTail", () => {
  it("取最后 N 行并脱敏", () => {
    const text = ["a", "b token=abc123def456", "c", "d"].join("\n")
    expect(redactedTail(text, 3)).toBe(["b token=***", "c", "d"].join("\n"))
  })

  it("超长行先截断再脱敏，并标出截断了多少", () => {
    const long = "x".repeat(5000)
    const out = redactedTail(long, 10, 4000)
    expect(out.length).toBeLessThan(4100)
    expect(out).toContain("截断 1000 字符")
  })

  it("超长且全是键名字符的行不会让正则卡住", () => {
    const evil = "token".repeat(800) // 4000 字符，贴着截断上限
    const t0 = Date.now()
    redactedTail(evil, 1, 4000)
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})

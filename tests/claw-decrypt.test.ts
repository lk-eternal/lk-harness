import { describe, it, expect } from "vitest"
import { clawDecryptSecret } from "../electron/cursor-claw-migrate.js"

const KEY_HEX = "899cee59081576b7d113e5c82389a03fcb4fedf73c9ec0a5db41aebe076aead4"
const BLOB_B64 = "djEwpqcsHMIn9/Db5A2Ybn3RHPkGn8IIAEJg7ozlBf5DkzJe7CnsyKitF3bhYGJ6Bw=="

describe("claw 密钥解密（Chromium os_crypt 格式）", () => {
  it("正确钥匙解出明文", () => {
    expect(clawDecryptSecret(BLOB_B64, Buffer.from(KEY_HEX, "hex"))).toBe("sk-test-secret-456")
  })

  it("错钥匙返回 null（不断言抛错）", () => {
    expect(clawDecryptSecret(BLOB_B64, Buffer.alloc(32, 7))).toBeNull()
  })

  it("非 v10/v11 版本返回 null", () => {
    const bad = Buffer.from("xx" + Buffer.from(BLOB_B64, "base64").subarray(2).toString("binary"), "binary").toString("base64")
    expect(clawDecryptSecret(bad, Buffer.from(KEY_HEX, "hex"))).toBeNull()
  })

  it("截断输入返回 null", () => {
    expect(clawDecryptSecret("djEwAQID", Buffer.from(KEY_HEX, "hex"))).toBeNull()
  })
})

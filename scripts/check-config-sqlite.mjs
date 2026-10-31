import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testToken = "current-test-token-123456789"
const mode = process.argv[2]

if (mode) {
  const { configStore, ConfigStore } = await import("../output/runtime/config/store.js")
  const { sqliteClient } = await import("../output/runtime/core/storage/sqlite/client.js")
  try {
    if (mode === "save-current") {
      const unopened = new ConfigStore()
      await unopened.save()
      assert.equal(unopened.get().persona.assistantLabel, "existing-label")
      assert.equal(unopened.get().web.authToken, testToken)
    } else if (mode === "expect-failure") {
      await assert.rejects(() => configStore.load(), /SQLite|Sqlite|条件写入/)
      assert.equal(configStore.meta().loaded, false)
    } else {
      await configStore.load()
      if (mode === "initial") {
        assert.equal(configStore.get().web.authToken, "")
        const auth = await import("../output/runtime/web/http/auth.js")
        assert.equal(auth.validateConfiguredWebToken(testToken), false)
        const ticket = auth.issueQuickLogin("owner")
        const session = auth.consumeQuickLogin(ticket.code)
        assert.equal(auth.validateWebToken(session.token), true)
        assert.throws(() => auth.consumeQuickLogin(ticket.code), /无效或已过期/)
      } else if (mode === "seed") {
        await Promise.all([
          configStore.update(config => { config.persona.assistantLabel = "existing-label" }),
          configStore.update(config => { config.web.authToken = testToken }),
        ])
        assert.equal(configStore.get().persona.assistantLabel, "existing-label")
        assert.equal(configStore.get().web.authToken, testToken)
      } else if (mode === "verify-saved") {
        assert.equal(configStore.get().persona.assistantLabel, "existing-label")
        assert.equal(configStore.get().web.authToken, testToken)
        assert.equal(configStore.getPublic().web.authToken, "********")
        const { validateConfiguredWebToken } = await import("../output/runtime/web/http/auth.js")
        assert.equal(validateConfiguredWebToken(testToken), true)
      } else if (mode === "clear-token") {
        await configStore.update(config => { config.web.authToken = "" })
      } else if (mode === "verify-empty") {
        assert.equal(configStore.get().web.authToken, "")
        assert.equal(configStore.get().persona.assistantLabel, "existing-label")
      } else if (mode === "fail-update") {
        const before = structuredClone(configStore.get())
        await assert.rejects(() => configStore.update(config => { config.persona.assistantLabel = "not-saved" }), /injected update failure/)
        assert.deepEqual(configStore.get(), before)
      }
    }
  } finally {
    await sqliteClient.close()
  }
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yui-config-sqlite-"))
  const file = path.join(root, "data/yui-chat/storage/state.sqlite3")
  const oldConfig = path.join(root, "config/config.json")
  const run = childMode => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), childMode], {
      cwd: pluginRoot,
      env: { ...process.env, YUI_CHAT_RUNTIME_ROOT: root, YUI_CHAT_PLUGIN_ROOT: pluginRoot },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", data => { output += data })
    child.stderr.on("data", data => { output += data })
    child.on("error", reject)
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`config fixture ${childMode} failed (${code}): ${output}`)))
  })
  const readRow = () => {
    const db = new Database(file, { readonly: true, fileMustExist: true })
    try { return db.prepare("SELECT revision, overrides_json FROM runtime_config WHERE id=1").get() } finally { db.close() }
  }
  try {
    // 无固定令牌时可使用主人一次性登录；旧文件即使损坏也不参与启动。
    await fs.mkdir(path.dirname(oldConfig), { recursive: true })
    const invalidOldConfig = "{invalid old config"
    await fs.writeFile(oldConfig, invalidOldConfig)
    await run("initial")
    assert.equal(await fs.readFile(oldConfig, "utf8"), invalidOldConfig)

    // 配置由 SQLite 持久化，并发更新与无参数保存不会丢失已保存的值。
    await run("seed")
    await run("save-current")
    assert.equal(JSON.parse(readRow().overrides_json).web.authToken, testToken)
    const conflictingOldConfig = JSON.stringify({ web: { authToken: "obsolete-test-token-12345" }, persona: { assistantLabel: "obsolete" } })
    await fs.writeFile(oldConfig, conflictingOldConfig)
    await run("verify-saved")
    assert.equal(await fs.readFile(oldConfig, "utf8"), conflictingOldConfig)

    // 写入失败不能发布未持久化的快照。
    const beforeUpdate = readRow()
    let db = new Database(file)
    db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON runtime_config BEGIN SELECT RAISE(ABORT, 'injected update failure'); END")
    db.close()
    await run("fail-update")
    assert.deepEqual(readRow(), beforeUpdate)
    db = new Database(file); db.exec("DROP TRIGGER fail_update"); db.close()
    await run("clear-token")
    await run("verify-empty")
    assert.equal(await fs.readFile(oldConfig, "utf8"), conflictingOldConfig)

    // 已有数据库缺失主配置行时不能重新创建默认行。
    db = new Database(file); db.prepare("DELETE FROM runtime_config").run(); db.close()
    await run("expect-failure")
    assert.equal(readRow(), undefined)

    // 已有向量库表明不是全新安装，状态库缺失时不能静默创建空库。
    await fs.unlink(file)
    await run("expect-failure")
    await assert.rejects(() => fs.access(file), error => error.code === "ENOENT")

    // 全新目录只采用默认值，旧文件里的 Token 不会被导入。
    await fs.rm(path.join(root, "data"), { recursive: true, force: true })
    await run("initial")
    assert.equal(await fs.readFile(oldConfig, "utf8"), conflictingOldConfig)
    console.log("ok config-sqlite: SQLite-only configuration, quick login, persisted tokens and failure protection")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

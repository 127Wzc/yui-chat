import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { dataDir } from "../config/store.js"
import { sqliteClient } from "../core/storage/sqlite/client.js"
import { InstallationError } from "./installation/types.js"

type SecretRecord = { id: string; alias: string; purpose: string; origin: string; scope: string; version: number; revoked: boolean; createdAt: number; envRef?: string; cipher?: string; nonce?: string; tag?: string }
const secretDir = path.join(dataDir, "installation-secrets")
const keyFile = path.join(secretDir, "key")
let keyPromise: Promise<Buffer> | null = null
async function masterKey(): Promise<Buffer> {
  keyPromise ||= (async () => {
    const external = process.env.YUI_CHAT_INSTALLATION_KEY
    if (external) {
      const bytes = Buffer.from(external, "base64")
      if (bytes.length !== 32) throw new InstallationError("CREDENTIAL_KEY_INVALID")
      return bytes
    }
    await fs.mkdir(secretDir, { recursive: true, mode: 0o700 })
    await fs.chmod(secretDir, 0o700)
    try { if (!(await fs.lstat(keyFile)).isFile()) throw new Error("invalid key file"); await fs.chmod(keyFile, 0o600); const bytes = Buffer.from(await fs.readFile(keyFile)); if (bytes.length !== 32) throw new Error("invalid key"); return bytes } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new InstallationError("CREDENTIAL_KEY_UNAVAILABLE")
      if (await sqliteClient.get("SELECT id FROM extension_credentials WHERE json_extract(payload,'$.cipher') IS NOT NULL LIMIT 1")) throw new InstallationError("CREDENTIAL_KEY_UNAVAILABLE")
      const bytes = crypto.randomBytes(32)
      try { await fs.writeFile(keyFile, bytes, { flag: "wx", mode: 0o600 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new InstallationError("CREDENTIAL_KEY_UNAVAILABLE")
        return Buffer.from(await fs.readFile(keyFile))
      }
      return bytes
    }
  })().catch(error => { keyPromise = null; throw error })
  return keyPromise
}

export class CredentialStore {
  async metadata(id: string): Promise<SecretRecord> {
    const row = await sqliteClient.get<{ payload: string }>("SELECT payload FROM extension_credentials WHERE id=?", [id])
    if (!row) throw new InstallationError("CREDENTIAL_REQUIRED")
    return JSON.parse(row.payload) as SecretRecord
  }
  async put(input: { alias?: string; purpose: string; origin: string; scope: string; value?: string; envRef?: string }): Promise<string> {
    if (!["repository-read", "mcp-auth", "installation-input"].includes(input.purpose) || typeof input.scope !== "string" || !input.scope || input.scope.length > 512 || typeof input.origin !== "string") throw new Error("凭据用途或绑定范围无效")
    if (input.purpose !== "installation-input") {
      const url = new URL(input.origin)
      if (!["https:", "http:"].includes(url.protocol) || url.origin !== input.origin) throw new Error("凭据必须绑定精确 origin")
    }
    const id = `cred_${crypto.randomUUID()}`
    const row: SecretRecord = { id, alias: String(input.alias || "读取凭据").slice(0, 80), purpose: input.purpose, origin: input.origin, scope: input.scope, version: 1, revoked: false, createdAt: Date.now() }
    if (input.envRef) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.envRef)) throw new Error("环境变量引用无效")
      row.envRef = input.envRef
    } else {
      if (typeof input.value !== "string" || !input.value || input.value.length > (input.purpose === "installation-input" ? 30 * 1024 * 1024 : 65536)) throw new Error("凭据值无效或过大")
      const nonce = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv("aes-256-gcm", await masterKey(), nonce)
      cipher.setAAD(Buffer.from(`${id}:1`))
      row.cipher = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]).toString("base64")
      row.nonce = nonce.toString("base64")
      row.tag = cipher.getAuthTag().toString("base64")
    }
    await sqliteClient.run("INSERT INTO extension_credentials VALUES(?,?)", [id, JSON.stringify(row)])
    return id
  }
  async resolve(id: string, purpose: string, origin: string, scope: string): Promise<{ value: string; version: number }> {
    const row = await this.metadata(id)
    if (row.revoked) throw new InstallationError("CREDENTIAL_REVOKED")
    if (row.purpose !== purpose || row.origin !== origin || row.scope !== scope) throw new InstallationError("CREDENTIAL_SCOPE_MISMATCH")
    let value: string
    if (row.envRef) {
      value = process.env[row.envRef] || ""
      if (!value) throw new InstallationError("CREDENTIAL_REQUIRED")
    } else {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", await masterKey(), Buffer.from(row.nonce!, "base64"))
        decipher.setAAD(Buffer.from(`${row.id}:${row.version}`))
        decipher.setAuthTag(Buffer.from(row.tag!, "base64"))
        value = Buffer.concat([decipher.update(Buffer.from(row.cipher!, "base64")), decipher.final()]).toString("utf8")
      } catch { throw new InstallationError("CREDENTIAL_KEY_UNAVAILABLE") }
    }
    return { value, version: row.version }
  }
  async boundCredential(purpose: string, origin: string, scope: string): Promise<string | undefined> {
    const rows = await sqliteClient.all<{ id: string }>("SELECT id FROM extension_credentials WHERE json_extract(payload,'$.purpose')=? AND json_extract(payload,'$.origin')=? AND json_extract(payload,'$.scope')=? AND json_extract(payload,'$.revoked')=0 LIMIT 2", [purpose, origin, scope])
    if (rows.length > 1) throw new InstallationError("CREDENTIAL_SELECTION_REQUIRED")
    return rows[0]?.id
  }
  async list() {
    return (await sqliteClient.all<{ payload: string }>("SELECT payload FROM extension_credentials WHERE json_extract(payload,'$.purpose') != 'installation-input' LIMIT 100")).map(row => {
      const { cipher: _cipher, nonce: _nonce, tag: _tag, envRef: _envRef, ...safe } = JSON.parse(row.payload) as SecretRecord
      return safe
    })
  }
  async revoke(id: string): Promise<void> {
    const row = await this.metadata(id)
    row.revoked = true
    // Revocation keeps authenticated ciphertext context unchanged; it can never be resolved again.
    await sqliteClient.run("UPDATE extension_credentials SET payload=? WHERE id=?", [JSON.stringify(row), id])
  }
  async removeInput(id: string): Promise<void> {
    await sqliteClient.run("DELETE FROM extension_credentials WHERE id=? AND json_extract(payload,'$.purpose')='installation-input'", [id])
  }
}
export const credentialStore = new CredentialStore()

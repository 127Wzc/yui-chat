import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "yui-benchmark-host-"))
try {
  const dataset = JSON.parse(await fs.readFile(path.join(root, "scripts/fixtures/command-retrieval-source-benchmark.json"), "utf8"))
  const changed = path.join(directory, dataset.files[0].file)
  await fs.mkdir(path.dirname(changed), { recursive: true })
  await fs.writeFile(changed, "changed source fixture")
  const args = [path.join(root, "scripts/check-command-benchmark.mjs"), "--host-root", directory]
  const normal = spawnSync(process.execPath, args, { encoding: "utf8" })
  assert.equal(normal.status, 0, normal.stderr)
  const report = JSON.parse(normal.stdout)
  assert.equal(report.sourceReviewRequired, true)
  assert(report.sources.changed.includes(dataset.files[0].file))
  assert(report.sources.missing.length > 0)
  const strict = spawnSync(process.execPath, [...args, "--verify-host"], { encoding: "utf8" })
  assert.equal(strict.status, 1)
  assert.equal(JSON.parse(strict.stdout).hostVerification, "failed")
  console.log("ok command benchmark: portable dataset validation and explicit strict host verification")
} finally { await fs.rm(directory, { recursive: true, force: true }) }

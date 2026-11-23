import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Build an offline, self-contained review artifact. This command does not load
// runtime configuration, open databases, execute plugins, or call a model.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const resultDir = path.resolve(process.argv[2] || path.join(root, "output/evaluations/20261123"))
const fixture = await fs.readFile(path.join(root, "scripts/fixtures/command-retrieval-source-benchmark.json"), "utf8")
const dataset = JSON.parse(fixture)
const manifest = JSON.parse(await fs.readFile(path.join(resultDir, "manifest.json"), "utf8"))
assert.equal(crypto.createHash("sha256").update(fixture).digest("hex"), manifest.datasetSha256, "题库版本与评测结果不同，不能混用")
const runs = {}
for (const mode of ["lexical", "hybrid", "hybrid-rerank"]) {
  const run = JSON.parse(await fs.readFile(path.join(resultDir, `${mode}.json`), "utf8"))
  assert.equal(run.run.datasetSha256, manifest.datasetSha256)
  assert.equal(run.run.corpusIdentity, manifest.corpusIdentity)
  runs[mode] = run.rows.map(row => ({
    caseId: row.caseId, status: row.status, reason: row.reason,
    latencyMs: row.latencyMs, warmLatencyMs: row.warmLatencyMs,
    retrieval: row.retrieval, results: row.results || [],
    deletionTargetsPresent: row.deletionTargetsPresent,
    deletionTargetsRequested: row.deletionTargetsRequested,
  }))
}
const data = {
  generatedAt: new Date().toISOString(),
  dataset: { version: dataset.version, createdAt: dataset.createdAt, provenance: dataset.provenance, k: dataset.k, targets: dataset.targets, cases: dataset.cases },
  manifest: { createdAt: manifest.createdAt, corpus: manifest.corpus, settings: manifest.settings, bindings: manifest.bindings, sourceAudit: manifest.sourceAudit },
  runs,
}
const template = await fs.readFile(path.join(root, "scripts/templates/command-benchmark-browser.html"), "utf8")
assert.equal(template.split("__YUI_BENCHMARK_DATA__").length, 2, "template must have one data slot")
const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
const html = template.replace("__YUI_BENCHMARK_DATA__", () => json)
const destination = path.join(resultDir, "question-bank.html")
await fs.writeFile(destination, html)
console.log(JSON.stringify({ file: destination, questions: dataset.cases.length, targets: dataset.targets.length, modes: Object.keys(runs).length, bytes: Buffer.byteLength(html) }))

import { knowledgeEvaluation } from "../../../../knowledge/evaluation.js"
import { evaluationRunner } from "../../../../knowledge/evaluation-runner.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp } from "../../route-handler.js"

export function registerKnowledgeEvaluationRoutes(app: RouteApp): void {
  const base = "/api/knowledge/evaluation"
  app.get(base, auth, handleRoute(async (_req, res) => {
    const overview = await knowledgeEvaluation.overview()
    overview.runs = overview.runs.map((run: Record<string, any>) => ({ ...run, status: ["queued", "running"].includes(run.status) && evaluationRunner.activeId() !== run.id ? "interrupted" : run.status }))
    res.json({ ok: true, ...overview })
  }))
  app.get(`${base}/plan`, auth, handleRoute(async (_req, res) => { res.json({ ok: true, plan: await evaluationRunner.plan() }) }, { errorStatus: 400 }))
  app.post(`${base}/start`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await evaluationRunner.start(req.body) }) }, { errorStatus: 400 }))
  app.post(`${base}/runs/:id/cancel`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...evaluationRunner.cancel(req.params.id) }) }, { errorStatus: 400 }))
  app.get(`${base}/runs/:id/export`, auth, handleRoute(async (req, res) => { res.json({ ok: true, bundle: await knowledgeEvaluation.exportRun(req.params.id) }) }))
  app.get(`${base}/commands`, auth, handleRoute(async (req, res) => { res.json({ ok: true, commands: await knowledgeEvaluation.commandOptions(String(req.query.q || "")) }) }))
  app.post(`${base}/cases`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.saveCase(req.body.case, req.body.expectedRevision) }) }, { errorStatus: 400 }))
  app.put(`${base}/cases/:id`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.saveCase(req.body.case, req.body.expectedRevision, req.params.id) }) }, { errorStatus: 400 }))
  app.delete(`${base}/cases/:id`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.deleteCase(req.params.id, req.body.expectedRevision) }) }, { errorStatus: 400 }))
  app.post(`${base}/targets`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.saveTarget(req.body.target, req.body.expectedRevision) }) }, { errorStatus: 400 }))
  app.put(`${base}/targets/:id`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.saveTarget(req.body.target, req.body.expectedRevision, req.params.id) }) }, { errorStatus: 400 }))
  app.put(`${base}/dataset`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.replaceDataset(req.body.dataset, req.body.expectedRevision) }) }, { errorStatus: 400 }))
  app.get(`${base}/runs/:id`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.getRun(req.params.id, req.query.binding === "original" ? "original" : "audited") }) }))
  app.post(`${base}/runs`, auth, handleRoute(async (req, res) => { res.json({ ok: true, ...await knowledgeEvaluation.importRun(req.body.bundle) }) }, { errorStatus: 400 }))
}

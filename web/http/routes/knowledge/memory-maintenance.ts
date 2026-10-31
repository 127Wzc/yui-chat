import { memoryMaintenance } from "../../../../memory/maintenance.js"
import { requireWebAuth as auth } from "../../auth.js"
import { handleRoute } from "../../route-handler.js"
import type { RouteApp,RouteRequest } from "../../route-handler.js"

const options=(req:RouteRequest)=>({useHistory:req.body.useHistory,count:req.body.count,actorId:(req.webPrincipal as {id?:string}|undefined)?.id})

/** 仅Web管理员入口；分析与应用分开，GET不发起模型调用。 */
export function registerMemoryMaintenanceRoutes(app:RouteApp,service=memoryMaintenance):void {
  const base="/api/memory/maintenance"
  app.get(base+"/groups/:groupId",auth,handleRoute(async(req,res)=>{
    res.set("Cache-Control","no-store")
    res.json({ok:true,jobs:await service.list(req.params.groupId,req.query.userId)})
  },{errorStatus:400}))
  app.post(base+"/groups/:groupId",auth,handleRoute(async(req,res)=>{
    res.json({ok:true,...await service.group(req.params.groupId,options(req))})
  },{errorStatus:400}))
  app.post(base+"/groups/:groupId/public",auth,handleRoute(async(req,res)=>{
    res.json({ok:true,job:await service.create(req.params.groupId,"",options(req))})
  },{errorStatus:400}))
  app.post(base+"/groups/:groupId/members/:userId",auth,handleRoute(async(req,res)=>{
    res.json({ok:true,job:await service.create(req.params.groupId,req.params.userId,options(req))})
  },{errorStatus:400}))
  app.get(base+"/jobs/:id",auth,handleRoute(async(req,res)=>{
    res.set("Cache-Control","no-store")
    res.json({ok:true,job:await service.view(req.params.id)})
  },{errorStatus:400}))
  app.get(base+"/jobs/:id/sources/:sourceId",auth,handleRoute(async(req,res)=>{
    res.set("Cache-Control","no-store")
    res.json({ok:true,source:await service.source(req.params.id,req.params.sourceId)})
  },{errorStatus:400}))
  app.get(base+"/jobs/:id/memories/:memoryId/evidence",auth,handleRoute(async(req,res)=>{
    res.set("Cache-Control","no-store")
    res.json({ok:true,evidence:await service.evidence(req.params.id,req.params.memoryId,req.query.page)})
  },{errorStatus:400}))
  app.post(base+"/jobs/:id/issues/:issueId/keep",auth,handleRoute(async(req,res)=>{res.json({ok:true,job:await service.keepIssue(req.params.id,req.params.issueId)})},{errorStatus:400}))
  app.post(base+"/jobs/:id/cancel",auth,handleRoute(async(req,res)=>{res.json({ok:true,job:await service.cancel(req.params.id)})},{errorStatus:400}))
  app.post(base+"/jobs/:id/retry",auth,handleRoute(async(req,res)=>{res.json({ok:true,job:await service.retry(req.params.id)})},{errorStatus:400}))
  app.post(base+"/jobs/:id/dismiss",auth,handleRoute(async(req,res)=>{res.json({ok:true,job:await service.dismiss(req.params.id)})},{errorStatus:400}))
  app.post(base+"/jobs/:id/apply",auth,handleRoute(async(req,res)=>{res.json({ok:true,job:await service.apply(req.params.id,req.body.selectedIds,req.body.edits)})},{errorStatus:400}))
  app.post(base+"/jobs/:id/undo",auth,handleRoute(async(req,res)=>{res.json({ok:true,job:await service.undo(req.params.id)})},{errorStatus:400}))
}

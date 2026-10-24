-- 保留正文与旧空间，不把旧距离结果重新解释为 cosine；重建由管理员显式触发。
UPDATE knowledge_index_jobs
SET status='superseded', lease_until=0,
    error='向量度量已统一为 cosine，请显式重建索引', updated_at=updated_at+1
WHERE distance_metric<>'cosine'
  AND status IN ('queued', 'running', 'canceling', 'retrying', 'paused_budget', 'paused_no_model');

UPDATE knowledge_bases
SET distance_metric='cosine', retrieval_json=json_set(retrieval_json, '$.distanceMetric', 'cosine'),
    active_vector_space_id=NULL, updated_at=updated_at+1
WHERE distance_metric<>'cosine';

-- 启动时已有 cosine 库的配置投影也可能缺失或残留旧字段，统一到权威列。
UPDATE knowledge_bases
SET retrieval_json=json_set(retrieval_json, '$.distanceMetric', 'cosine')
WHERE json_extract(retrieval_json, '$.distanceMetric') IS NOT 'cosine';

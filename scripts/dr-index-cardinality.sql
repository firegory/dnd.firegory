SELECT 'active_nfs_entries' AS metric, count(*) AS value
FROM nfs_index_entries
WHERE lifecycle = 'active'
UNION ALL
SELECT 'active_nfs_chunks', count(*)
FROM chunks c
JOIN files f ON f.id = c.file_id AND f.active_generation_id = c.generation_id
JOIN nfs_index_managed_files m ON m.file_id = c.file_id
UNION ALL
SELECT 'missing_nfs_embeddings', count(*)
FROM chunks c
JOIN files f ON f.id = c.file_id AND f.active_generation_id = c.generation_id
JOIN nfs_index_managed_files m ON m.file_id = c.file_id
WHERE c.embedding IS NULL
ORDER BY metric;

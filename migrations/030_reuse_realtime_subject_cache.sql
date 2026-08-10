WITH glm_setting AS (
  SELECT COALESCE(
    (SELECT NULLIF(value->>'model', '') FROM app_settings WHERE key = 'glm_image_matching'),
    'glm-4.6v-flash'
  ) AS model
), cached_subjects AS (
  SELECT DISTINCT ON (feature.id)
    feature.id, cache.subject_box, cache.embedding, cache.model, cache.box_source
  FROM product_image_features feature
  CROSS JOIN glm_setting setting
  JOIN image_subject_cache cache
    ON cache.url_hash = feature.url_hash
   AND cache.model IN (setting.model, 'glm-4.6v-flash')
  WHERE feature.subject_status IN ('waiting', 'pending')
  ORDER BY feature.id, (cache.model = setting.model) DESC, cache.updated_at DESC
)
UPDATE product_image_features feature
SET subject_status = 'ready',
    subject_box = cached.subject_box,
    subject_embedding_vector = cached.embedding,
    subject_model = cached.model,
    subject_error = NULL,
    subject_box_source = cached.box_source,
    subject_updated_at = now()
FROM cached_subjects cached
WHERE feature.id = cached.id;

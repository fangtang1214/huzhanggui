CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE product_image_features
  ADD COLUMN embedding_vector vector(512);

ALTER TABLE image_match_runs
  ADD COLUMN timings jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE image_embedding_cache (
  url_hash char(64) NOT NULL,
  model varchar(120) NOT NULL,
  image_url text NOT NULL,
  embedding vector(512) NOT NULL,
  hits bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (url_hash, model)
);
CREATE INDEX image_embedding_cache_last_used_idx ON image_embedding_cache(last_used_at DESC);

-- Q8 与原 FP32 特征不能混用。升级后由后台索引器逐步重建，原图仍不会落盘。
ALTER TABLE product_image_features
  ALTER COLUMN model SET DEFAULT 'Xenova/clip-vit-base-patch32:q8';
UPDATE product_image_features
SET model = 'Xenova/clip-vit-base-patch32:q8',
    embedding = NULL,
    embedding_vector = NULL,
    status = 'pending',
    error = NULL,
    attempts = 0,
    updated_at = now();

UPDATE app_settings
SET value = jsonb_set(value, '{model}', '"Xenova/clip-vit-base-patch32:q8"'::jsonb, true),
    updated_at = now()
WHERE key = 'image_matching';

CREATE INDEX product_image_features_embedding_hnsw_idx
  ON product_image_features
  USING hnsw (embedding_vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE status = 'ready' AND embedding_vector IS NOT NULL;

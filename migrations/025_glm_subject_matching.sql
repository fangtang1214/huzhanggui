ALTER TABLE product_image_features
  ADD COLUMN subject_status varchar(20) NOT NULL DEFAULT 'waiting'
    CHECK (subject_status IN ('waiting', 'pending', 'processing', 'ready', 'failed')),
  ADD COLUMN subject_box jsonb,
  ADD COLUMN subject_embedding_vector vector(512),
  ADD COLUMN subject_error text,
  ADD COLUMN subject_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN subject_updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX product_image_features_subject_status_idx
  ON product_image_features(subject_status, subject_updated_at);

CREATE INDEX product_image_features_subject_hnsw_idx
  ON product_image_features
  USING hnsw (subject_embedding_vector vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE subject_status = 'ready' AND subject_embedding_vector IS NOT NULL;

CREATE TABLE image_subject_cache (
  url_hash char(64) NOT NULL,
  model varchar(120) NOT NULL,
  image_url text NOT NULL,
  subject_box jsonb NOT NULL,
  embedding vector(512) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (url_hash, model)
);

INSERT INTO app_settings(key, value)
VALUES ('glm_image_matching', '{"configured":false,"indexingStatus":"idle","model":"glm-4.6v-flash"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

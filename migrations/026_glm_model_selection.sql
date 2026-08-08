ALTER TABLE product_image_features
  ADD COLUMN subject_model varchar(120);

UPDATE product_image_features
SET subject_model = coalesce(
  (SELECT value->>'model' FROM app_settings WHERE key='glm_image_matching'),
  'glm-4.6v-flash'
)
WHERE subject_status = 'ready' AND subject_model IS NULL;

CREATE INDEX product_image_features_subject_model_idx
  ON product_image_features(subject_model, subject_status, subject_updated_at DESC);

ALTER TABLE product_image_features
  ADD COLUMN subject_box_source varchar(20) NOT NULL DEFAULT 'glm'
    CHECK (subject_box_source IN ('glm', 'manual')),
  ADD COLUMN subject_corrected_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN subject_corrected_at timestamptz;

ALTER TABLE image_subject_cache
  ADD COLUMN box_source varchar(20) NOT NULL DEFAULT 'glm'
    CHECK (box_source IN ('glm', 'manual'));

CREATE INDEX product_image_features_subject_manual_idx
  ON product_image_features(subject_corrected_at DESC)
  WHERE subject_box_source = 'manual';

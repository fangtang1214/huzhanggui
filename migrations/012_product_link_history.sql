CREATE TABLE product_link_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url text NOT NULL,
  replaced_by_url text,
  source varchar(40) NOT NULL CHECK (source IN ('product_edit', 'link_issue', 'intake_merge', 'recognition_correction')),
  source_entity_id uuid,
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX product_link_history_product_changed_idx
ON product_link_history(product_id, changed_at DESC);

CREATE INDEX product_link_history_changed_by_idx
ON product_link_history(changed_by);

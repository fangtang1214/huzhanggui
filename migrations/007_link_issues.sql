CREATE TABLE link_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  previous_issue_id uuid REFERENCES link_issues(id) ON DELETE SET NULL,
  reported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reported_department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  old_product_url text,
  report_note text NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'replaced', 'no_change', 'unresolved', 'cancelled')),
  new_product_url text,
  resolution_note text,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(btrim(report_note)) > 0),
  CHECK (status <> 'replaced' OR new_product_url IS NOT NULL),
  CHECK (status NOT IN ('no_change', 'unresolved') OR length(btrim(coalesce(resolution_note, ''))) > 0)
);

-- 一个商品同一时间只能存在一条待处理报障，避免不同部门重复联系供应链。
CREATE UNIQUE INDEX link_issues_one_pending_product_unique
  ON link_issues(product_id)
  WHERE status = 'pending';
CREATE INDEX link_issues_status_created_idx ON link_issues(status, created_at DESC);
CREATE INDEX link_issues_department_created_idx ON link_issues(reported_department_id, created_at DESC);
CREATE INDEX link_issues_product_created_idx ON link_issues(product_id, created_at DESC);
CREATE INDEX link_issues_previous_idx ON link_issues(previous_issue_id) WHERE previous_issue_id IS NOT NULL;

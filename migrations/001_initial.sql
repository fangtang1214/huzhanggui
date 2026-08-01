CREATE TABLE departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'other' CHECK (kind IN ('business', 'live_room', 'management', 'other')),
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX departments_name_unique ON departments (lower(name));

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  description text,
  permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_scope varchar(20) NOT NULL DEFAULT 'department' CHECK (data_scope IN ('all', 'department')),
  is_system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_name_unique ON roles (lower(name));

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username varchar(80) NOT NULL,
  name varchar(100) NOT NULL,
  password_hash text NOT NULL,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_unique ON users (lower(username));
CREATE INDEX users_department_idx ON users(department_id);
CREATE INDEX users_role_idx ON users(role_id);

CREATE TABLE sessions (
  token_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(80) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_unique ON categories (lower(name));

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(50) NOT NULL,
  color varchar(20) NOT NULL DEFAULT '#56736a',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_name_unique ON tags (lower(name));

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  name varchar(100) NOT NULL,
  code varchar(50),
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX locations_department_name_unique ON locations(department_id, lower(name));
CREATE INDEX locations_department_idx ON locations(department_id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku varchar(100) NOT NULL,
  name varchar(200) NOT NULL,
  business_contact_id uuid REFERENCES users(id) ON DELETE SET NULL,
  store_name varchar(200),
  price numeric(12,2),
  product_url text,
  commission varchar(100),
  store_rating numeric(4,2),
  supply_chain varchar(200),
  cooperation_mechanism text,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  image_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_sku_unique ON products(lower(sku));
CREATE INDEX products_category_idx ON products(category_id);
CREATE INDEX products_contact_idx ON products(business_contact_id);
CREATE INDEX products_archived_idx ON products(archived);

CREATE TABLE product_departments (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE RESTRICT,
  PRIMARY KEY (product_id, department_id)
);
CREATE INDEX product_departments_department_idx ON product_departments(department_id);

CREATE TABLE product_tags (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
  PRIMARY KEY (product_id, tag_id)
);
CREATE INDEX product_tags_tag_idx ON product_tags(tag_id);

CREATE SEQUENCE sample_code_seq START 1;

CREATE TABLE samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(64) NOT NULL,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  arrived_at date NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'returned', 'consumed', 'damaged', 'lost', 'gifted', 'scrapped')),
  current_department_id uuid REFERENCES departments(id) ON DELETE RESTRICT,
  current_location_id uuid REFERENCES locations(id) ON DELETE RESTRICT,
  note text,
  archived boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX samples_code_unique ON samples(code);
CREATE INDEX samples_product_idx ON samples(product_id);
CREATE INDEX samples_department_idx ON samples(current_department_id);
CREATE INDEX samples_location_idx ON samples(current_location_id);
CREATE INDEX samples_status_idx ON samples(status);
CREATE INDEX samples_arrived_idx ON samples(arrived_at DESC);

CREATE TABLE sample_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid,
  sample_id uuid NOT NULL REFERENCES samples(id) ON DELETE RESTRICT,
  from_status varchar(20),
  from_department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  from_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  to_status varchar(20) NOT NULL,
  to_department_id uuid REFERENCES departments(id) ON DELETE SET NULL,
  to_location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sample_movements_sample_idx ON sample_movements(sample_id, created_at DESC);
CREATE INDEX sample_movements_operator_idx ON sample_movements(operator_id);
CREATE INDEX sample_movements_created_idx ON sample_movements(created_at DESC);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action varchar(80) NOT NULL,
  entity_type varchar(50) NOT NULL,
  entity_id varchar(100),
  summary text NOT NULL,
  changes jsonb,
  ip_address varchar(80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id);
CREATE INDEX audit_logs_user_idx ON audit_logs(user_id);

CREATE TABLE app_settings (
  key varchar(100) PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO categories(name) VALUES ('服装'), ('美妆'), ('食品'), ('家居') ON CONFLICT DO NOTHING;
INSERT INTO tags(name, color) VALUES ('重点推广', '#c56b45'), ('高佣金', '#b48a3f') ON CONFLICT DO NOTHING;

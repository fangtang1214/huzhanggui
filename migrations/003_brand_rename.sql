UPDATE app_settings
SET value = jsonb_set(value, '{name}', to_jsonb('狐掌柜-直播样品管理系统'::text), true)
WHERE key = 'company'
  AND value->>'name' IN ('斯源直播样品管理系统', '斯源样品管理系统');

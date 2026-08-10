INSERT INTO league_cooperative_cache_state(
  league_account_id, item_count, synced_at, sync_status, sync_requested_at
)
SELECT id, 0, '1970-01-01 00:00:00+00', 'pending', now()
FROM league_accounts
WHERE active = true
ON CONFLICT (league_account_id) DO UPDATE
SET sync_status = 'pending',
    sync_requested_at = now(),
    sync_error = null
WHERE league_cooperative_cache_state.sync_status <> 'running';

DELETE FROM league_product_lookup_throttles;

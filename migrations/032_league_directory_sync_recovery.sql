ALTER TABLE league_cooperative_cache_state
  ADD COLUMN IF NOT EXISTS sync_progress_count integer NOT NULL DEFAULT 0
    CHECK (sync_progress_count >= 0),
  ADD COLUMN IF NOT EXISTS sync_heartbeat_at timestamptz;

UPDATE league_cooperative_cache_state state
SET sync_status = CASE WHEN account.active THEN 'pending' ELSE 'idle' END,
    sync_requested_at = CASE WHEN account.active THEN coalesce(state.sync_requested_at, now()) ELSE null END,
    sync_started_at = null,
    sync_heartbeat_at = null,
    sync_error = null
FROM league_accounts account
WHERE account.id = state.league_account_id
  AND state.sync_status = 'running';

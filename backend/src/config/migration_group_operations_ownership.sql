-- Ensure group operation history is owned and queryable by the admin user.

ALTER TABLE group_operations
  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

ALTER TABLE group_operations
  ADD COLUMN IF NOT EXISTS operation_type VARCHAR(50);

ALTER TABLE group_operations
  ADD COLUMN IF NOT EXISTS total_users INTEGER;

ALTER TABLE group_operations
  ADD COLUMN IF NOT EXISTS options JSONB;

UPDATE group_operations go
SET user_id = s.user_id
FROM sessions s
WHERE go.user_id IS NULL
  AND go.session_id = s.id;

UPDATE group_operations
SET operation_type = operation
WHERE operation_type IS NULL
  AND operation IS NOT NULL;

UPDATE group_operations
SET total_users = total_count
WHERE total_users IS NULL
  AND total_count IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_group_operations_user_id
  ON group_operations(user_id);

CREATE INDEX IF NOT EXISTS idx_group_operations_user_created
  ON group_operations(user_id, created_at DESC);

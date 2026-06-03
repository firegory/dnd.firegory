-- Telegram account linking table.
-- Stores the association between a Telegram user ID and a website user account.

CREATE TABLE IF NOT EXISTS telegram_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id),
  UNIQUE (telegram_id)
);

-- Link tokens: short-lived codes for the /link flow
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code VARCHAR(6) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  UNIQUE (code)
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_tokens_code
  ON telegram_link_tokens (code) WHERE used_at IS NULL;

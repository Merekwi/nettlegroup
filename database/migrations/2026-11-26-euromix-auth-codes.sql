-- Migration: add a one-time native-app sign-in bridge for Euromix.
-- Safe to apply more than once.
CREATE TABLE IF NOT EXISTS public.euromix_auth_codes (
  code_hash TEXT PRIMARY KEY,
  telegram_id BIGINT NOT NULL REFERENCES public.user_profiles(telegram_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS euromix_auth_codes_expiry_idx
  ON public.euromix_auth_codes (expires_at)
  WHERE consumed_at IS NULL;

-- Nettle Group database schema
-- Applied to Neon project nettlegroup / database nettle_main on 2026-10-29.
-- This file is the reproducible baseline schema. Never put secrets in this file.

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_id BIGINT NOT NULL UNIQUE,
  telegram_username TEXT,
  display_name TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.service_catalog (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_label TEXT NOT NULL DEFAULT '',
  duration_days INTEGER,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_catalog_duration_positive CHECK (duration_days IS NULL OR duration_days > 0)
);

CREATE TABLE IF NOT EXISTS public.payment_methods (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  payment_details TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payment_tickets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_code TEXT NOT NULL UNIQUE,
  user_id BIGINT NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  service_id BIGINT REFERENCES public.service_catalog(id) ON DELETE SET NULL,
  payment_method_id BIGINT REFERENCES public.payment_methods(id) ON DELETE SET NULL,
  amount_label TEXT NOT NULL DEFAULT '',
  payment_reference TEXT NOT NULL DEFAULT '',
  user_comment TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  admin_comment TEXT NOT NULL DEFAULT '',
  reviewed_by BIGINT REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_tickets_status_valid CHECK (status IN ('awaiting_payment','paid_submitted','approved','rejected','cancelled'))
);

CREATE TABLE IF NOT EXISTS public.service_grants (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  service_id BIGINT REFERENCES public.service_catalog(id) ON DELETE SET NULL,
  ticket_id BIGINT REFERENCES public.payment_tickets(id) ON DELETE SET NULL,
  granted_by BIGINT REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_grants_status_valid CHECK (status IN ('active','expired','revoked')),
  CONSTRAINT service_grants_expiry_valid CHECK (expires_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS public.site_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by BIGINT REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_tickets_user_created_idx ON public.payment_tickets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_tickets_status_created_idx ON public.payment_tickets(status, created_at DESC);
CREATE INDEX IF NOT EXISTS service_grants_user_status_idx ON public.service_grants(user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON public.audit_logs(created_at DESC);

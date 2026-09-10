BEGIN;

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'inactive',
  ADD COLUMN IF NOT EXISTS billing_notes TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_accounts_asaas_customer_id
  ON customer_accounts(asaas_customer_id)
  WHERE asaas_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  billing_type TEXT NOT NULL CHECK (billing_type IN ('ONE_TIME','MONTHLY','QUARTERLY','SEMIANNUALLY','YEARLY','CUSTOM')),
  pricing_model TEXT NOT NULL DEFAULT 'FIXED' CHECK (pricing_model IN ('FIXED','PER_ACTIVE_SENSOR','TIERED')),
  amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  unit_amount NUMERIC(14,2) CHECK (unit_amount IS NULL OR unit_amount >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_plan_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES billing_plans(id) ON DELETE CASCADE,
  min_units INTEGER NOT NULL CHECK (min_units >= 0),
  max_units INTEGER CHECK (max_units IS NULL OR max_units >= min_units),
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_plan_tier_range
  ON billing_plan_tiers(plan_id,min_units,COALESCE(max_units,-1));

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES billing_plans(id),
  asaas_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','cancelled','overdue','finished')),
  payment_method TEXT NOT NULL DEFAULT 'UNDEFINED' CHECK (payment_method IN ('BOLETO','CREDIT_CARD','PIX','UNDEFINED')),
  due_day SMALLINT CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  start_date DATE,
  custom_amount NUMERIC(14,2) CHECK (custom_amount IS NULL OR custom_amount >= 0),
  discount_type TEXT CHECK (discount_type IS NULL OR discount_type IN ('PERCENT','FIXED')),
  discount_value NUMERIC(14,2) CHECK (discount_value IS NULL OR discount_value >= 0),
  discount_until DATE,
  grace_days INTEGER NOT NULL DEFAULT 0 CHECK (grace_days >= 0),
  suspend_after_days INTEGER CHECK (suspend_after_days IS NULL OR suspend_after_days >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscriptions_asaas_id
  ON billing_subscriptions(asaas_subscription_id)
  WHERE asaas_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_account ON billing_subscriptions(account_id,status);

CREATE TABLE IF NOT EXISTS billing_charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  asaas_payment_id TEXT,
  external_reference TEXT,
  description TEXT,
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  due_date DATE NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'UNDEFINED',
  status TEXT NOT NULL DEFAULT 'PENDING',
  invoice_url TEXT,
  bank_slip_url TEXT,
  pix_payload TEXT,
  paid_at TIMESTAMPTZ,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_charges_asaas_payment
  ON billing_charges(asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_billing_charges_account_due ON billing_charges(account_id,due_date DESC);
CREATE INDEX IF NOT EXISTS idx_billing_charges_status ON billing_charges(status,due_date);

CREATE TABLE IF NOT EXISTS asaas_webhook_events (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asaas_webhook_unprocessed
  ON asaas_webhook_events(received_at)
  WHERE processed_at IS NULL;

COMMIT;

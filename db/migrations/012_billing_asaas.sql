CREATE TABLE IF NOT EXISTS billing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  charge_type text NOT NULL CHECK (charge_type IN ('recurring','single')),
  cycle text CHECK (cycle IN ('WEEKLY','BIWEEKLY','MONTHLY','BIMONTHLY','QUARTERLY','SEMIANNUALLY','YEARLY')),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  billing_mode text NOT NULL DEFAULT 'fixed' CHECK (billing_mode IN ('fixed','per_sensor','tiered')),
  base_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (base_amount >= 0),
  per_sensor_amount numeric(12,2) NOT NULL DEFAULT 0 CHECK (per_sensor_amount >= 0),
  tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((charge_type='single' AND cycle IS NULL) OR (charge_type='recurring' AND cycle IS NOT NULL))
);

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS asaas_customer_id text,
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'unconfigured',
  ADD COLUMN IF NOT EXISTS billing_plan_id uuid REFERENCES billing_plans(id),
  ADD COLUMN IF NOT EXISTS billing_due_day integer CHECK (billing_due_day BETWEEN 1 AND 28),
  ADD COLUMN IF NOT EXISTS billing_discount_type text CHECK (billing_discount_type IN ('fixed','percent')),
  ADD COLUMN IF NOT EXISTS billing_discount_value numeric(12,2) CHECK (billing_discount_value >= 0),
  ADD COLUMN IF NOT EXISTS billing_discount_until date,
  ADD COLUMN IF NOT EXISTS billing_exempt_until date;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_accounts_asaas_customer_id
  ON customer_accounts(asaas_customer_id) WHERE asaas_customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES billing_plans(id),
  provider text NOT NULL DEFAULT 'asaas',
  provider_subscription_id text,
  amount numeric(12,2) NOT NULL,
  cycle text,
  billing_type text NOT NULL DEFAULT 'UNDEFINED',
  next_due_date date,
  status text NOT NULL DEFAULT 'pending',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_subscriptions_provider
  ON billing_subscriptions(provider,provider_subscription_id) WHERE provider_subscription_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_billing_subscriptions_account ON billing_subscriptions(account_id);

CREATE TABLE IF NOT EXISTS billing_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'asaas',
  provider_payment_id text,
  amount numeric(12,2) NOT NULL,
  due_date date,
  billing_type text,
  status text NOT NULL DEFAULT 'pending',
  description text,
  invoice_url text,
  bank_slip_url text,
  pix_payload text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_charges_provider
  ON billing_charges(provider,provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_billing_charges_account_due ON billing_charges(account_id,due_date DESC);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'asaas',
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_event_id)
);

CREATE TABLE IF NOT EXISTS billing_audit_log (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_billing_audit_account ON billing_audit_log(account_id,created_at DESC);

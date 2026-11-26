CREATE TABLE enterprise.sandboxes (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  business_effective_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz NULL
);

CREATE TABLE enterprise.suppliers (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'suspended')),
  currency text NOT NULL CHECK (currency = 'EUR'),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, reference)
);

CREATE INDEX suppliers_sandbox_status_idx
  ON enterprise.suppliers (sandbox_id, status);

CREATE TABLE enterprise.products (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  sku text NOT NULL CHECK (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  category text NOT NULL CHECK (char_length(category) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('active', 'discontinued')),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, sku)
);

CREATE INDEX products_sandbox_status_idx
  ON enterprise.products (sandbox_id, status);

CREATE TABLE enterprise.customers (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, reference)
);

CREATE INDEX customers_sandbox_status_idx
  ON enterprise.customers (sandbox_id, status);

CREATE TABLE enterprise.agreements (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  supplier_id uuid NOT NULL,
  product_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'expired', 'revoked')),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0 AND unit_price_minor <= 1000000000000),
  currency text NOT NULL CHECK (currency = 'EUR'),
  capacity_quantity integer NOT NULL CHECK (capacity_quantity >= 0 AND capacity_quantity <= 1000000),
  lead_time_days integer NOT NULL CHECK (lead_time_days >= 0 AND lead_time_days <= 365),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, reference),
  UNIQUE (sandbox_id, supplier_id, product_id),
  CHECK (valid_to >= valid_from),
  FOREIGN KEY (sandbox_id, supplier_id)
    REFERENCES enterprise.suppliers (sandbox_id, id),
  FOREIGN KEY (sandbox_id, product_id)
    REFERENCES enterprise.products (sandbox_id, id)
);

CREATE INDEX agreements_sandbox_product_status_idx
  ON enterprise.agreements (sandbox_id, product_id, status);

CREATE INDEX agreements_sandbox_supplier_status_idx
  ON enterprise.agreements (sandbox_id, supplier_id, status);

CREATE TABLE enterprise.purchase_orders (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  supplier_reference text NULL CHECK (
    supplier_reference IS NULL OR supplier_reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  ),
  supplier_id uuid NOT NULL,
  status text NOT NULL CHECK (
    status IN ('open', 'acknowledged', 'delayed', 'partially_received', 'received', 'cancelled')
  ),
  payment_terms text NOT NULL CHECK (char_length(payment_terms) BETWEEN 1 AND 200),
  delivery_terms text NOT NULL CHECK (char_length(delivery_terms) BETWEEN 1 AND 200),
  ordered_at timestamptz NOT NULL,
  expected_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, reference),
  FOREIGN KEY (sandbox_id, supplier_id)
    REFERENCES enterprise.suppliers (sandbox_id, id)
);

CREATE INDEX purchase_orders_sandbox_supplier_status_idx
  ON enterprise.purchase_orders (sandbox_id, supplier_id, status);

CREATE INDEX purchase_orders_sandbox_supplier_reference_idx
  ON enterprise.purchase_orders (sandbox_id, supplier_reference);

CREATE INDEX purchase_orders_sandbox_status_expected_idx
  ON enterprise.purchase_orders (sandbox_id, status, expected_at, id);

CREATE TABLE enterprise.purchase_order_lines (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  purchase_order_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1 AND line_number <= 999),
  product_id uuid NOT NULL,
  ordered_quantity integer NOT NULL CHECK (ordered_quantity >= 1 AND ordered_quantity <= 1000000),
  received_quantity integer NOT NULL CHECK (received_quantity >= 0 AND received_quantity <= 1000000),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0 AND unit_price_minor <= 1000000000000),
  currency text NOT NULL CHECK (currency = 'EUR'),
  confirmed_arrival_at timestamptz NOT NULL,
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, purchase_order_id, line_number),
  CHECK (received_quantity <= ordered_quantity),
  FOREIGN KEY (sandbox_id, purchase_order_id)
    REFERENCES enterprise.purchase_orders (sandbox_id, id),
  FOREIGN KEY (sandbox_id, product_id)
    REFERENCES enterprise.products (sandbox_id, id)
);

CREATE INDEX purchase_order_lines_sandbox_product_arrival_idx
  ON enterprise.purchase_order_lines (sandbox_id, product_id, confirmed_arrival_at, id);

CREATE TABLE enterprise.sales_orders (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  reference text NOT NULL CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  customer_id uuid NOT NULL,
  status text NOT NULL CHECK (
    status IN ('confirmed', 'allocated', 'shipped', 'delivered', 'cancelled')
  ),
  currency text NOT NULL CHECK (currency = 'EUR'),
  ordered_at timestamptz NOT NULL,
  promised_delivery_at timestamptz NOT NULL,
  shipped_at timestamptz NULL,
  delivered_at timestamptz NULL,
  contractual_penalty_daily_minor bigint NULL CHECK (
    contractual_penalty_daily_minor IS NULL OR (
      contractual_penalty_daily_minor >= 0 AND contractual_penalty_daily_minor <= 1000000000000
    )
  ),
  contractual_penalty_cap_minor bigint NULL CHECK (
    contractual_penalty_cap_minor IS NULL OR (
      contractual_penalty_cap_minor >= 0 AND contractual_penalty_cap_minor <= 1000000000000
    )
  ),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, reference),
  FOREIGN KEY (sandbox_id, customer_id)
    REFERENCES enterprise.customers (sandbox_id, id)
);

CREATE INDEX sales_orders_sandbox_status_deadline_idx
  ON enterprise.sales_orders (sandbox_id, status, promised_delivery_at, id);

CREATE INDEX sales_orders_sandbox_customer_idx
  ON enterprise.sales_orders (sandbox_id, customer_id);

CREATE TABLE enterprise.sales_order_lines (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  sales_order_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number >= 1 AND line_number <= 999),
  product_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity >= 1 AND quantity <= 1000000),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0 AND unit_price_minor <= 1000000000000),
  currency text NOT NULL CHECK (currency = 'EUR'),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, sales_order_id, line_number),
  FOREIGN KEY (sandbox_id, sales_order_id)
    REFERENCES enterprise.sales_orders (sandbox_id, id),
  FOREIGN KEY (sandbox_id, product_id)
    REFERENCES enterprise.products (sandbox_id, id)
);

CREATE INDEX sales_order_lines_sandbox_product_idx
  ON enterprise.sales_order_lines (sandbox_id, product_id, sales_order_id);

CREATE TABLE enterprise.inventory (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  product_id uuid NOT NULL,
  on_hand_quantity integer NOT NULL CHECK (on_hand_quantity >= 0 AND on_hand_quantity <= 1000000),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  UNIQUE (sandbox_id, product_id),
  FOREIGN KEY (sandbox_id, product_id)
    REFERENCES enterprise.products (sandbox_id, id)
);

CREATE TABLE enterprise.inventory_reservations (
  id uuid PRIMARY KEY,
  sandbox_id uuid NOT NULL REFERENCES enterprise.sandboxes(id),
  product_id uuid NOT NULL,
  sales_order_id uuid NULL,
  status text NOT NULL CHECK (status IN ('active', 'released', 'fulfilled')),
  quantity integer NOT NULL CHECK (quantity >= 1 AND quantity <= 1000000),
  version integer NOT NULL CHECK (version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (sandbox_id, id),
  FOREIGN KEY (sandbox_id, product_id)
    REFERENCES enterprise.products (sandbox_id, id),
  FOREIGN KEY (sandbox_id, sales_order_id)
    REFERENCES enterprise.sales_orders (sandbox_id, id)
);

CREATE INDEX inventory_reservations_sandbox_product_status_idx
  ON enterprise.inventory_reservations (sandbox_id, product_id, status);

REVOKE ALL ON enterprise.sandboxes FROM PUBLIC;
REVOKE ALL ON enterprise.suppliers FROM PUBLIC;
REVOKE ALL ON enterprise.products FROM PUBLIC;
REVOKE ALL ON enterprise.customers FROM PUBLIC;
REVOKE ALL ON enterprise.agreements FROM PUBLIC;
REVOKE ALL ON enterprise.purchase_orders FROM PUBLIC;
REVOKE ALL ON enterprise.purchase_order_lines FROM PUBLIC;
REVOKE ALL ON enterprise.sales_orders FROM PUBLIC;
REVOKE ALL ON enterprise.sales_order_lines FROM PUBLIC;
REVOKE ALL ON enterprise.inventory FROM PUBLIC;
REVOKE ALL ON enterprise.inventory_reservations FROM PUBLIC;

GRANT SELECT ON enterprise.sandboxes TO enterprise_app;
GRANT SELECT ON enterprise.suppliers TO enterprise_app;
GRANT SELECT ON enterprise.products TO enterprise_app;
GRANT SELECT ON enterprise.customers TO enterprise_app;
GRANT SELECT ON enterprise.agreements TO enterprise_app;
GRANT SELECT ON enterprise.purchase_orders TO enterprise_app;
GRANT SELECT ON enterprise.purchase_order_lines TO enterprise_app;
GRANT SELECT ON enterprise.sales_orders TO enterprise_app;
GRANT SELECT ON enterprise.sales_order_lines TO enterprise_app;
GRANT SELECT ON enterprise.inventory TO enterprise_app;
GRANT SELECT ON enterprise.inventory_reservations TO enterprise_app;

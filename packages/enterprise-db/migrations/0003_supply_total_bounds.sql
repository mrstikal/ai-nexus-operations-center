ALTER TABLE enterprise.purchase_order_lines
  ADD CONSTRAINT purchase_order_lines_total_value_check
  CHECK (ordered_quantity::bigint * unit_price_minor <= 1000000000000);

ALTER TABLE enterprise.sales_order_lines
  ADD CONSTRAINT sales_order_lines_total_value_check
  CHECK (quantity::bigint * unit_price_minor <= 1000000000000);

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sandboxes } from './cases.js';
import type { BudgetAccountState, BudgetOwnerKind } from '@nexus/ai/budgets';

export const nexusSchema = pgSchema('nexus');

export const budgetAccounts = nexusSchema.table(
  'budget_accounts',
  {
    id: uuid('id').primaryKey(),
    sandboxId: uuid('sandbox_id')
      .notNull()
      .references(() => sandboxes.id),
    ownerKind: text('owner_kind').$type<BudgetOwnerKind>().notNull(),
    ownerId: text('owner_id').notNull(),
    parentAccountId: uuid('parent_account_id'),
    depth: integer('depth').notNull(),
    capMicrousd: bigint('cap_microusd', { mode: 'bigint' }).notNull(),
    usedMicrousd: bigint('used_microusd', { mode: 'bigint' }).notNull(),
    reservedMicrousd: bigint('reserved_microusd', { mode: 'bigint' }).notNull(),
    state: text('state').$type<BudgetAccountState>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('budget_accounts_sandbox_owner_key').on(
      table.sandboxId,
      table.ownerKind,
      table.ownerId,
    ),
    uniqueIndex('budget_accounts_sandbox_id_id_key').on(table.sandboxId, table.id),
    index('budget_accounts_parent_idx').on(table.sandboxId, table.parentAccountId),
    foreignKey({
      columns: [table.sandboxId, table.parentAccountId],
      foreignColumns: [table.sandboxId, table.id],
      name: 'budget_accounts_parent_fk',
    }),
    check(
      'budget_accounts_kind_check',
      sql`${table.ownerKind} IN ('case','run','document','evaluation','assistant','briefing','indexing')`,
    ),
    check(
      'budget_accounts_state_check',
      sql`${table.state} IN ('active','closed')`,
    ),
    check(
      'budget_accounts_amounts_check',
      sql`${table.capMicrousd} >= 0 AND ${table.usedMicrousd} >= 0 AND ${table.reservedMicrousd} >= 0`,
    ),
    check(
      'budget_accounts_depth_check',
      sql`${table.depth} BETWEEN 0 AND 3`,
    ),
  ],
);

export type BudgetAccountRow = typeof budgetAccounts.$inferSelect;

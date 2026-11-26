import {
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const nexusSchema = pgSchema('nexus');

export const policyBundles = nexusSchema.table('policy_bundles', {
  revision: text('revision').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  bundle: jsonb('bundle').$type<Record<string, unknown>>().notNull(),
  contentHash: text('content_hash').notNull(),
  canonicalTextPath: text('canonical_text_path').notNull(),
  canonicalTextHash: text('canonical_text_hash').notNull(),
  status: text('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export type PolicyBundleRow = typeof policyBundles.$inferSelect;

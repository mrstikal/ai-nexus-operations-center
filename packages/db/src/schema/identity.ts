import {
  boolean,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const nexusSchema = pgSchema('nexus');

export const users = nexusSchema.table('users', {
  id: uuid('id').primaryKey(),
  username: text('username').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  passwordParams: jsonb('password_params')
    .$type<{ n: number; r: number; p: number; keylen: number }>()
    .notNull(),
  isActive: boolean('is_active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const userRoles = nexusSchema.table(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.role] })],
);

export const sessions = nexusSchema.table('sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenDigest: text('token_digest').notNull(),
  csrfDigest: text('csrf_digest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const preauthChallenges = nexusSchema.table('preauth_challenges', {
  id: uuid('id').primaryKey(),
  tokenDigest: text('token_digest').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Role } from '@nexus/contracts';
import type { NexusDb } from '../connection.js';
import {
  preauthChallenges,
  sessions,
  userRoles,
  users,
} from '../schema/identity.js';
import type {
  AuthenticatedSession,
  IdentityStore,
  LoginUserRecord,
} from '@nexus/application/identity/sessions';
import type { PasswordHashRecord } from '@nexus/application/identity/passwords';

interface SessionRow {
  sessionId: string;
  userId: string;
  csrfDigest: string;
  expiresAt: Date;
  username: string;
  displayName: string;
}

export function createIdentityStore(db: NexusDb): IdentityStore {
  return {
    async insertSession(input) {
      const rows = await db
        .insert(sessions)
        .values({
          id: input.id,
          userId: input.userId,
          tokenDigest: input.tokenDigest,
          csrfDigest: input.csrfDigest,
          createdAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp() + (${input.ttlSeconds} * interval '1 second')`,
        })
        .returning({ expiresAt: sessions.expiresAt });
      const row = rows[0];
      if (!row) {
        throw new Error('Session insert returned no row');
      }
      return { expiresAt: row.expiresAt };
    },

    async findSessionByTokenDigest(tokenDigest): Promise<AuthenticatedSession | null> {
      const rows = await db
        .select({
          sessionId: sessions.id,
          userId: sessions.userId,
          csrfDigest: sessions.csrfDigest,
          expiresAt: sessions.expiresAt,
          username: users.username,
          displayName: users.displayName,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.tokenDigest, tokenDigest),
            isNull(sessions.revokedAt),
            eq(users.isActive, true),
            sql`${sessions.expiresAt} > clock_timestamp()`,
          ),
        )
        .limit(1);
      const row = rows[0] as SessionRow | undefined;
      if (!row) {
        return null;
      }
      const roleRows = await db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, row.userId));
      return {
        sessionId: row.sessionId,
        userId: row.userId,
        username: row.username,
        displayName: row.displayName,
        roles: roleRows.map((entry) => entry.role) as Role[],
        expiresAt: row.expiresAt,
        csrfDigest: row.csrfDigest,
      };
    },

    async revokeSession(sessionId) {
      await db
        .update(sessions)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    },

    async updateSessionCsrf(sessionId, csrfDigest) {
      await db
        .update(sessions)
        .set({ csrfDigest })
        .where(eq(sessions.id, sessionId));
    },

    async insertPreauthChallenge(input) {
      const rows = await db
        .insert(preauthChallenges)
        .values({
          id: input.id,
          tokenDigest: input.tokenDigest,
          createdAt: sql`clock_timestamp()`,
          expiresAt: sql`clock_timestamp() + (${input.ttlSeconds} * interval '1 second')`,
        })
        .returning({ expiresAt: preauthChallenges.expiresAt });
      const row = rows[0];
      if (!row) {
        throw new Error('Preauth insert returned no row');
      }
      return { expiresAt: row.expiresAt };
    },

    async consumePreauthChallenge(tokenDigest) {
      const consumed = await db
        .update(preauthChallenges)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(preauthChallenges.tokenDigest, tokenDigest),
            isNull(preauthChallenges.consumedAt),
            sql`${preauthChallenges.expiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: preauthChallenges.id });
      return consumed.length === 1;
    },

    async findUserForLogin(username): Promise<LoginUserRecord | null> {
      const rows = await db
        .select({
          userId: users.id,
          username: users.username,
          displayName: users.displayName,
          passwordHash: users.passwordHash,
          passwordSalt: users.passwordSalt,
          passwordParams: users.passwordParams,
          isActive: users.isActive,
        })
        .from(users)
        .where(sql`lower(${users.username}) = lower(${username})`)
        .limit(1);
      return rows[0] ?? null;
    },

    async listRoles(userId) {
      const rows = await db
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));
      return rows.map((entry) => entry.role) as Role[];
    },
  };
}

export interface CreateIdentityUserInput {
  readonly username: string;
  readonly displayName: string;
  readonly roles: readonly Role[];
  readonly password: PasswordHashRecord;
}

export async function createIdentityUser(
  db: NexusDb,
  input: CreateIdentityUserInput,
): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(input.username)) {
    throw new Error('Username does not match the allowed format');
  }
  if (input.displayName.length < 1 || input.displayName.length > 200) {
    throw new Error('Display name is outside its allowed length');
  }
  const roles = [...new Set(input.roles)];
  if (roles.length === 0) {
    throw new Error('User must have at least one role');
  }
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${input.username})`)
    .limit(1);
  if (existing.length > 0) {
    return false;
  }

  try {
    await db.transaction(async (tx) => {
      const userId = randomUUID();
      await tx.insert(users).values({
        id: userId,
        username: input.username.toLowerCase(),
        displayName: input.displayName,
        passwordHash: input.password.hash,
        passwordSalt: input.password.salt,
        passwordParams: input.password.params,
        isActive: true,
        createdAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      });
      await tx.insert(userRoles).values(
        roles.map((role) => ({ userId, role })),
      );
    });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return false;
    }
    throw error;
  }
}

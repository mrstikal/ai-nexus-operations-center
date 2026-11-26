import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RoleSchema, type Role } from '@nexus/contracts';
import { hashPassword, verifyPassword } from './passwords.js';

export const SESSION_TTL_HOURS = 8;
export const PREAUTH_TTL_MINUTES = 5;
export const SESSION_COOKIE_NAME = 'nexus_session';

export interface AuthenticatedSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly roles: Role[];
  readonly expiresAt: Date;
  readonly csrfDigest: string;
}

export interface LoginUserRecord {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly passwordParams: { n: number; r: number; p: number; keylen: number };
  readonly isActive: boolean;
}

export interface IdentityStore {
  insertSession(input: {
    id: string;
    userId: string;
    tokenDigest: string;
    csrfDigest: string;
    ttlSeconds: number;
  }): Promise<{ expiresAt: Date }>;
  findSessionByTokenDigest(tokenDigest: string): Promise<AuthenticatedSession | null>;
  revokeSession(sessionId: string): Promise<void>;
  updateSessionCsrf(sessionId: string, csrfDigest: string): Promise<void>;
  insertPreauthChallenge(input: {
    id: string;
    tokenDigest: string;
    ttlSeconds: number;
  }): Promise<{ expiresAt: Date }>;
  consumePreauthChallenge(tokenDigest: string): Promise<boolean>;
  findUserForLogin(username: string): Promise<LoginUserRecord | null>;
  listRoles(userId: string): Promise<Role[]>;
}

export interface CreatedSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export interface CreatedChallenge {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AuthenticatedUser {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly roles: Role[];
}

export function digestToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function constantTimeDigestEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export async function createSession(
  store: IdentityStore,
  userId: string,
): Promise<CreatedSession> {
  const token = generateToken();
  const csrfToken = generateToken();
  const created = await store.insertSession({
    id: randomUUID(),
    userId,
    tokenDigest: digestToken(token),
    csrfDigest: digestToken(csrfToken),
    ttlSeconds: SESSION_TTL_HOURS * 60 * 60,
  });
  return { token, csrfToken, expiresAt: created.expiresAt };
}

export async function findSessionByToken(
  store: IdentityStore,
  token: string,
): Promise<AuthenticatedSession | null> {
  if (token.length < 16 || token.length > 200) {
    return null;
  }
  return store.findSessionByTokenDigest(digestToken(token));
}

export async function revokeSession(store: IdentityStore, sessionId: string): Promise<void> {
  await store.revokeSession(sessionId);
}

export async function rotateSessionCsrf(
  store: IdentityStore,
  sessionId: string,
): Promise<string> {
  const csrfToken = generateToken();
  await store.updateSessionCsrf(sessionId, digestToken(csrfToken));
  return csrfToken;
}

export function verifySessionCsrf(session: AuthenticatedSession, csrfToken: string): boolean {
  return constantTimeDigestEqual(session.csrfDigest, digestToken(csrfToken));
}

export async function createPreauthChallenge(
  store: IdentityStore,
): Promise<CreatedChallenge> {
  const token = generateToken();
  const created = await store.insertPreauthChallenge({
    id: randomUUID(),
    tokenDigest: digestToken(token),
    ttlSeconds: PREAUTH_TTL_MINUTES * 60,
  });
  return { token, expiresAt: created.expiresAt };
}

export async function consumePreauthChallenge(
  store: IdentityStore,
  token: string,
): Promise<boolean> {
  if (token.length < 16 || token.length > 200) {
    return false;
  }
  return store.consumePreauthChallenge(digestToken(token));
}

let dummyPasswordRecord: Awaited<ReturnType<typeof hashPassword>> | null = null;

async function getDummyPasswordRecord(): Promise<Awaited<ReturnType<typeof hashPassword>>> {
  if (!dummyPasswordRecord) {
    dummyPasswordRecord = await hashPassword('not-a-real-user-password');
  }
  return dummyPasswordRecord;
}

export async function authenticateUser(
  store: IdentityStore,
  username: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const row = await store.findUserForLogin(username);
  const passwordRecord = row
    ? {
        hash: row.passwordHash,
        salt: row.passwordSalt,
        params: row.passwordParams,
      }
    : await getDummyPasswordRecord();
  const valid = await verifyPassword(password, passwordRecord);
  if (!row || !valid || !row.isActive) {
    return null;
  }
  return {
    userId: row.userId,
    username: row.username,
    displayName: row.displayName,
    roles: RoleSchema.array().parse(await store.listRoles(row.userId)),
  };
}

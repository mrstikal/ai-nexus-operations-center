import { z } from 'zod';
import { IsoUtcTimestampSchema, RoleSchema, UuidSchema } from './common.js';

export const AuthUserSchema = z
  .object({
    id: UuidSchema,
    username: z.string().min(1).max(100),
    displayName: z.string().min(1).max(200),
    roles: z.array(RoleSchema).max(10),
  })
  .strict();
export type AuthUser = z.infer<typeof AuthUserSchema>;

export const AuthMeResponseSchema = z
  .object({
    user: AuthUserSchema,
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict();
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;

export const LoginResponseSchema = AuthMeResponseSchema.extend({
  csrfToken: z.string().min(16).max(200),
}).strict();
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const CsrfResponseSchema = z
  .object({
    csrfToken: z.string().min(16).max(200),
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict();
export type CsrfResponse = z.infer<typeof CsrfResponseSchema>;

export const LoginRequestSchema = z
  .object({
    username: z.string().min(1).max(100),
    password: z.string().min(8).max(200),
  })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LogoutResponseSchema = z
  .object({
    loggedOut: z.literal(true),
  })
  .strict();
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

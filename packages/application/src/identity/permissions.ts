import type { Role } from '@nexus/contracts';

export const PERMISSIONS = [
  'case:read',
  'case:write',
  'document:read',
  'document:upload',
  'document:correct',
  'proposal:edit',
  'proposal:clarify',
  'run:cancel',
  'assistant:use',
  'demo:launch',
  'approval:ops',
  'approval:finance',
  'knowledge:manage',
  'config:manage',
  'evaluation:manage',
  'demo:manage',
  'trace:read',
  'dashboard:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER_PERMISSIONS: readonly Permission[] = [
  'case:read',
  'document:read',
  'trace:read',
  'dashboard:read',
];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: VIEWER_PERMISSIONS,
  operator: [
    ...VIEWER_PERMISSIONS,
    'case:write',
    'document:upload',
    'document:correct',
    'proposal:edit',
    'proposal:clarify',
    'run:cancel',
    'assistant:use',
    'demo:launch',
  ],
  approver_ops: [...VIEWER_PERMISSIONS, 'approval:ops'],
  approver_finance: [...VIEWER_PERMISSIONS, 'approval:finance'],
  admin: [
    ...VIEWER_PERMISSIONS,
    'knowledge:manage',
    'config:manage',
    'evaluation:manage',
    'demo:manage',
  ],
};

export function effectiveRoles(roles: readonly Role[]): Role[] {
  const effective = new Set<Role>(roles);
  if (roles.length > 0) {
    effective.add('viewer');
  }
  return [...effective];
}

export function hasAnyRole(
  roles: readonly Role[],
  requiredRoles: readonly Role[],
): boolean {
  const effective = new Set(effectiveRoles(roles));
  return requiredRoles.some((role) => effective.has(role));
}

export function permissionsForRoles(roles: readonly Role[]): Permission[] {
  const permissions = new Set<Permission>();
  for (const role of effectiveRoles(roles)) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      permissions.add(permission);
    }
  }
  return [...permissions];
}

export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return permissionsForRoles(roles).includes(permission);
}

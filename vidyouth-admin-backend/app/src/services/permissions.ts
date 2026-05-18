/**
 * RBAC permission matrix — server-side source of truth.
 *
 * Mirrors PRD §16.1 "RBAC Permission Matrix" and §7.6 Super Admin
 * categories. PRD is explicit: "Authorization: RBAC enforced at API
 * gateway AND service level — never client-side only".
 *
 * PRD role → system role: SUPER_ADMIN→superadmin, Org Admin→admin
 * (tenant-scoped, NOT platform admin), ORG_USER→organisation,
 * VENDOR→vendor, B2C_USER→student.
 */

export type Role =
  | 'student'
  | 'admin'
  | 'vendor'
  | 'organisation'
  | 'superadmin';

export type Permission =
  | 'access_admin_panel'
  | 'manage_all_users'
  | 'create_edit_content'
  | 'configure_pricing'
  | 'view_any_user_data'
  | 'issue_revoke_certificates'
  | 'access_payment_data'
  | 'configure_feature_toggles'
  | 'post_jobs'
  | 'publish_news_social'
  | 'manage_organisations'
  | 'manage_vendors'
  | 'view_audit_logs'
  | 'mark_offline_attendance'
  | 'access_vendor_portal'
  | 'apply_to_jobs'
  | 'build_resume';

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  superadmin: new Set<Permission>([
    'access_admin_panel',
    'manage_all_users',
    'create_edit_content',
    'configure_pricing',
    'view_any_user_data',
    'issue_revoke_certificates',
    'access_payment_data',
    'configure_feature_toggles',
    'post_jobs',
    'publish_news_social',
    'manage_organisations',
    'manage_vendors',
    'view_audit_logs',
  ]),
  admin: new Set<Permission>([
    'manage_all_users', // own org only — enforced by the org service layer
    'view_any_user_data',
  ]),
  organisation: new Set<Permission>(['view_any_user_data']),
  vendor: new Set<Permission>(['access_vendor_portal', 'mark_offline_attendance']),
  student: new Set<Permission>(['apply_to_jobs', 'build_resume']),
};

export function can(role: Role | string | undefined, permission: Permission): boolean {
  if (!role) return false;
  const set = MATRIX[role as Role];
  return set ? set.has(permission) : false;
}

export function permissionsFor(role: Role | string | undefined): Permission[] {
  if (!role) return [];
  const set = MATRIX[role as Role];
  return set ? [...set] : [];
}

export class ForbiddenError extends Error {
  permission: Permission;
  constructor(permission: Permission) {
    super('forbidden');
    this.name = 'ForbiddenError';
    this.permission = permission;
  }
}

export function assertCan(role: Role | string | undefined, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}

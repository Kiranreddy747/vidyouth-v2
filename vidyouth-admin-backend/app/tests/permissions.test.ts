import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { can, permissionsFor, assertCan, ForbiddenError } from '../src/services/permissions.js';

describe('RBAC permission matrix (PRD §16.1)', () => {
  test('superadmin can access the admin panel', () => {
    assert.equal(can('superadmin', 'access_admin_panel'), true);
  });

  test('every non-superadmin role is denied the admin panel', () => {
    for (const role of ['admin', 'organisation', 'vendor', 'student'] as const) {
      assert.equal(can(role, 'access_admin_panel'), false, `${role} must NOT access admin panel`);
    }
  });

  test('vendor → vendor portal, not admin panel', () => {
    assert.equal(can('vendor', 'access_vendor_portal'), true);
    assert.equal(can('vendor', 'access_admin_panel'), false);
  });

  test('student (B2C) → apply jobs + resume only', () => {
    assert.equal(can('student', 'apply_to_jobs'), true);
    assert.equal(can('student', 'build_resume'), true);
    assert.equal(can('student', 'configure_pricing'), false);
  });

  test('unknown / missing role denied everything', () => {
    assert.equal(can(undefined, 'access_admin_panel'), false);
    assert.equal(can('ghost', 'apply_to_jobs'), false);
  });

  test('permissionsFor returns the full superadmin set', () => {
    const p = permissionsFor('superadmin');
    assert.ok(p.includes('access_admin_panel'));
    assert.ok(p.includes('view_audit_logs'));
    assert.ok(p.length >= 10);
  });

  test('assertCan throws ForbiddenError when denied', () => {
    assert.throws(() => assertCan('student', 'access_admin_panel'), ForbiddenError);
    assert.doesNotThrow(() => assertCan('superadmin', 'access_admin_panel'));
  });
});

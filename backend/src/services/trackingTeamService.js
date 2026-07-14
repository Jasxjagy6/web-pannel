const { pool } = require('../config/database');
const { AppError } = require('../utils/errorHandler');

/**
 * Default permission set per tracking role. A member's effective
 * permissions are this preset shallow-merged with their own
 * tracking_team_members.permissions JSONB overrides.
 *
 * `security` gates decrypting/viewing 2FA password/hint/recovery
 * email/security notes. `manageTeam` gates the Team page itself.
 * Both are additional to the six permissions named in the product spec
 * (view/edit/delete/export/sales/earnings).
 */
const ROLE_PRESETS = {
  owner: {
    view: true, edit: true, delete: true, export: true,
    sales: true, earnings: true, security: true, manageTeam: true,
  },
  admin: {
    view: true, edit: true, delete: true, export: true,
    sales: true, earnings: true, security: true, manageTeam: false,
  },
  staff: {
    view: true, edit: true, delete: false, export: false,
    sales: false, earnings: false, security: false, manageTeam: false,
  },
  viewer: {
    view: true, edit: false, delete: false, export: false,
    sales: false, earnings: false, security: false, manageTeam: false,
  },
};

const VALID_ROLES = Object.keys(ROLE_PRESETS);

function effectivePermissions(role, overrides) {
  return { ...ROLE_PRESETS[role], ...(overrides || {}) };
}

const trackingTeamService = {
  ROLE_PRESETS,
  VALID_ROLES,

  /**
   * Resolve a user's tracking role + effective permissions.
   *
   * An explicit tracking_team_members row always wins. Absent one, any
   * panel admin (users.role = 'admin') is treated as a virtual owner —
   * this covers admins promoted after migration_v43 seeded existing
   * ones. Returns null when the user has no tracking access at all.
   */
  async resolveMember(userId) {
    const memberResult = await pool.query(
      `SELECT tm.role, tm.permissions, u.email
         FROM tracking_team_members tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.user_id = $1`,
      [userId]
    );
    const row = memberResult.rows[0];
    if (row) {
      return {
        userId,
        email: row.email,
        role: row.role,
        permissions: effectivePermissions(row.role, row.permissions),
        source: 'explicit',
      };
    }

    const userResult = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1',
      [userId]
    );
    const user = userResult.rows[0];
    if (user && user.role === 'admin') {
      return {
        userId,
        email: user.email,
        role: 'owner',
        permissions: effectivePermissions('owner'),
        source: 'admin_fallback',
      };
    }
    return null;
  },

  async listMembers() {
    const { rows } = await pool.query(
      `SELECT tm.id, tm.user_id, tm.role, tm.permissions, tm.added_by, tm.created_at, tm.updated_at,
              u.email
         FROM tracking_team_members tm
         JOIN users u ON u.id = tm.user_id
        ORDER BY tm.created_at ASC`
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      email: r.email,
      role: r.role,
      permissions: effectivePermissions(r.role, r.permissions),
      permissionOverrides: r.permissions,
      addedBy: r.added_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  },

  async addMember(actorUserId, { userId, role, permissions }) {
    if (!VALID_ROLES.includes(role)) {
      throw new AppError(`Invalid role: ${role}`, 400, 'INVALID_TRACKING_ROLE');
    }
    const userExists = await pool.query('SELECT id, email FROM users WHERE id = $1', [userId]);
    if (!userExists.rows[0]) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const { rows } = await pool.query(
      `INSERT INTO tracking_team_members (user_id, role, permissions, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, updated_at = NOW()
       RETURNING id, user_id, role, permissions, created_at, updated_at`,
      [userId, role, JSON.stringify(permissions || {}), actorUserId]
    );
    const row = rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      email: userExists.rows[0].email,
      role: row.role,
      permissions: effectivePermissions(row.role, row.permissions),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },

  async updateMember(targetUserId, { role, permissions }) {
    if (role && !VALID_ROLES.includes(role)) {
      throw new AppError(`Invalid role: ${role}`, 400, 'INVALID_TRACKING_ROLE');
    }
    const existing = await pool.query(
      'SELECT role, permissions FROM tracking_team_members WHERE user_id = $1',
      [targetUserId]
    );
    if (!existing.rows[0]) {
      throw new AppError('Tracking team member not found', 404, 'TRACKING_MEMBER_NOT_FOUND');
    }
    const nextRole = role || existing.rows[0].role;
    const nextPermissions = permissions !== undefined ? permissions : existing.rows[0].permissions;

    const { rows } = await pool.query(
      `UPDATE tracking_team_members
          SET role = $1, permissions = $2, updated_at = NOW()
        WHERE user_id = $3
      RETURNING id, user_id, role, permissions, created_at, updated_at`,
      [nextRole, JSON.stringify(nextPermissions || {}), targetUserId]
    );
    const row = rows[0];
    return {
      id: row.id,
      userId: row.user_id,
      role: row.role,
      permissions: effectivePermissions(row.role, row.permissions),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },

  async removeMember(targetUserId) {
    const { rowCount } = await pool.query(
      'DELETE FROM tracking_team_members WHERE user_id = $1',
      [targetUserId]
    );
    if (rowCount === 0) {
      throw new AppError('Tracking team member not found', 404, 'TRACKING_MEMBER_NOT_FOUND');
    }
    return { removed: true };
  },
};

module.exports = trackingTeamService;

/**
 * Deep Feed AI Admin — middleware/permissions.js
 * Role-based permission checking for admin routes.
 */

function requirePermission(...required) {
  return (req, res, next) => {
    const perms = req.user?.permissions || [];
    if (perms.includes('*')) return next();
    const hasAll = required.every(p => {
      const [resource] = p.split('.');
      return perms.includes(p) || perms.includes(`${resource}.*`);
    });
    if (!hasAll) return res.status(403).json({ error: 'Insufficient permissions', required });
    next();
  };
}

function requirePlatformAdmin(req, res, next) {
  if (req.user?.type !== 'platform-admin') {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  next();
}

module.exports = { requirePermission, requirePlatformAdmin };

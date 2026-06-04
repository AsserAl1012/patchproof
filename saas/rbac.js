export const ROLES = Object.freeze({
  owner: {
    rank: 5,
    permissions: [
      "org:read",
      "org:write",
      "project:read",
      "project:write",
      "run:create",
      "run:read",
      "run:apply",
      "certificate:download",
      "audit:read",
      "admin:read",
      "admin:write",
      "api_key:write"
    ]
  },
  admin: {
    rank: 4,
    permissions: [
      "org:read",
      "org:write",
      "project:read",
      "project:write",
      "run:create",
      "run:read",
      "run:apply",
      "certificate:download",
      "audit:read",
      "admin:read",
      "admin:write"
    ]
  },
  developer: {
    rank: 3,
    permissions: ["org:read", "project:read", "project:write", "run:create", "run:read", "certificate:download"]
  },
  reviewer: {
    rank: 2,
    permissions: ["org:read", "project:read", "run:read", "run:apply", "certificate:download"]
  },
  auditor: {
    rank: 1,
    permissions: ["org:read", "project:read", "run:read", "certificate:download", "audit:read"]
  }
});

export function hasPermission(role, permission) {
  return Boolean(ROLES[role]?.permissions.includes(permission));
}

export function requirePermission(role, permission) {
  if (!hasPermission(role, permission)) {
    const error = new Error(`Role '${role || "none"}' lacks '${permission}'.`);
    error.statusCode = 403;
    throw error;
  }
}

export function normalizeRole(role) {
  if (!ROLES[role]) {
    const error = new Error(`Unknown role '${role}'.`);
    error.statusCode = 400;
    throw error;
  }
  return role;
}

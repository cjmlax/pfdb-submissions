import dotenv from 'dotenv';

dotenv.config();

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

// All runtime configuration in one place. Required-at-use secrets (Teable token)
// are read lazily so the worker can still boot and serve /healthz with an
// incomplete config. Admin auth is handled entirely by the SPA bearer token
// (see userAuth below) — there is no cookie/session login.
export const config = {
  port: Number(opt('PORT', '8080')),
  host: opt('HOST', '0.0.0.0'),
  dataDir: opt('DATA_DIR', './data'),
  allowedOrigin: opt('ALLOWED_ORIGIN', '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Salt for hashing submitter IPs (abuse tracking). Falls back to the old
  // COOKIE_SECRET so existing deployments keep producing the same hashes.
  ipHashSecret: opt('IP_HASH_SECRET', opt('COOKIE_SECRET', 'change-me-ip-salt')),

  // Verification config for tokens issued to the public SPA. This is a separate
  // Authentik application from the admin OIDC above. These are public values
  // (the client id is not a secret), so the defaults are safe to ship.
  userAuth: {
    issuer:      opt('USER_OIDC_ISSUER', 'https://authentik.cjmlax.com/application/o/pfdb/'),
    clientId:    opt('USER_OIDC_CLIENT_ID', 'gYpSjz6qGj1e1HUPihJeMt9aTP9I0ymgA877eScc'),
    groupsClaim: opt('USER_OIDC_GROUPS_CLAIM', 'pfdb_groups'),
    // Group (within pfdb_groups) that grants SPA admin powers. The SPA scope
    // mapping strips the "pfdb-" prefix, so "pfdb-admins" arrives as "admins".
    adminGroup:  opt('USER_OIDC_ADMIN_GROUP', 'admins'),
  },

  teable: {
    baseUrl: opt('TEABLE_BASE_URL', 'https://teable.cjmlax.com').replace(/\/$/, ''),
    token: opt('TEABLE_TOKEN', ''),
    // Table IDs are resolved by name at runtime (see resolveTableId) and cached,
    // so individual table IDs no longer need to be configured — only the base.
    baseId: opt('TEABLE_BASE_ID', 'bseylZk8mJzj9xeoAHy'),
  },

  upload: {
    maxBytes: Number(opt('UPLOAD_MAX_BYTES', String(5 * 1024 * 1024))),
  },

  image: {
    quality: Number(opt('IMAGE_QUALITY', '80')),
  },

  export: {
    hashRefreshCron: opt('EXPORT_HASH_CRON', '0 0 * * *'),
  },

  changelog: {
    // Absolute path to changelog.json in the web root (SMB build output).
    // Leave empty to disable the iTunes poller.
    path: opt('CHANGELOG_PATH', ''),
    pollCron: opt('CHANGELOG_POLL_CRON', '0 6 * * *'), // daily at 6 AM
  },

  weeklySets: {
    pollCron: opt('WEEKLY_SETS_POLL_CRON', '2 14 * * 1'), // Mondays at 2:02 PM ET
  },

  notify: {
    webhookUrls: opt('WEBHOOK_URL', '').split(',').map((s) => s.trim()).filter(Boolean),
    adminUrl: opt('ADMIN_URL', '').replace(/\/$/, ''),
    on: {
      submit:  opt('WEBHOOK_ON_SUBMIT',  'true') !== 'false',
      approve: opt('WEBHOOK_ON_APPROVE', 'true') !== 'false',
      reject:  opt('WEBHOOK_ON_REJECT',  'true') !== 'false',
    },
  },
};

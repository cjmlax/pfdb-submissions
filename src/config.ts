import dotenv from 'dotenv';

dotenv.config();

function opt(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

export type AuthMode = 'forward' | 'oidc' | 'password';

// All runtime configuration in one place. Required-at-use secrets (Teable token,
// admin password, OIDC client secret) are read lazily so the worker can still
// boot and serve /healthz with an incomplete config.
export const config = {
  port: Number(opt('PORT', '8080')),
  host: opt('HOST', '0.0.0.0'),
  dataDir: opt('DATA_DIR', './data'),
  allowedOrigin: opt('ALLOWED_ORIGIN', '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  auth: {
    mode: opt('AUTH_MODE', 'forward') as AuthMode,
    adminGroup: opt('ADMIN_GROUP', 'pfdb-admin'),
    // forward mode
    userHeader: opt('FORWARD_USER_HEADER', 'x-authentik-username').toLowerCase(),
    groupsHeader: opt('FORWARD_GROUPS_HEADER', 'x-authentik-groups').toLowerCase(),
    proxySecret: opt('TRUST_PROXY_SECRET', ''),
    // password mode
    password: opt('ADMIN_PASSWORD', ''),
    // shared
    cookieSecret: opt('COOKIE_SECRET', 'insecure-dev-cookie-secret-change-me'),
    // oidc mode
    oidc: {
      issuer: opt('OIDC_ISSUER', ''),
      clientId: opt('OIDC_CLIENT_ID', ''),
      clientSecret: opt('OIDC_CLIENT_SECRET', ''),
      redirectUri: opt('OIDC_REDIRECT_URI', ''),
      groupsClaim: opt('OIDC_GROUPS_CLAIM', 'groups'),
      scope: opt('OIDC_SCOPE', 'openid profile email groups'),
    },
  },

  teable: {
    baseUrl: opt('TEABLE_BASE_URL', 'https://teable.cjmlax.com').replace(/\/$/, ''),
    token: opt('TEABLE_TOKEN', ''),
    tables: {
      frogs:  opt('FROGS_TABLE_ID',  'tblgaaUnZGx1i61RCOZ'),
      breeds: opt('BREEDS_TABLE_ID', 'tbliUWaVe4eKqJkVEv4'),
      chroma: opt('CHROMA_TABLE_ID', 'tbluqJI6VaHK0fWiPo6'),
      glass:  opt('GLASS_TABLE_ID',  'tblaToM9WCudYNtRjaV'),
      sets:   opt('SETS_TABLE_ID',   'tblOuIZRVGlTPLAfM56'),
    },
  },

  upload: {
    maxBytes: Number(opt('UPLOAD_MAX_BYTES', String(5 * 1024 * 1024))),
  },

  export: {
    refreshIntervalHours: Number(opt('EXPORT_REFRESH_HOURS', '24')),
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

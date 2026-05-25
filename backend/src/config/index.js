require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

module.exports = {
  env:      process.env.NODE_ENV || 'development',
  port:     parseInt(process.env.PORT || '3001', 10),

  db: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME     || 'paypal_qbo',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },

  jwt: {
    secret:    process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiresIn: '8h',
  },

  // 32-byte hex string → used as AES-256 key for token encryption
  // Fallback is dev-only: 64 hex chars = 32 bytes. NEVER use in production.
  encryptionKey: process.env.ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000',

  qbo: {
    clientId:     process.env.QBO_CLIENT_ID     || '',
    clientSecret: process.env.QBO_CLIENT_SECRET || '',
    redirectUri:  process.env.QBO_REDIRECT_URI  || 'http://localhost:3001/api/quickbooks/callback',
    environment:  process.env.QBO_ENVIRONMENT   || 'sandbox',
    baseUrl:
      (process.env.QBO_ENVIRONMENT || 'sandbox') === 'production'
        ? 'https://quickbooks.api.intuit.com'
        : 'https://sandbox-quickbooks.api.intuit.com',
  },

  paypal: {
    environment: process.env.PAYPAL_ENVIRONMENT || 'sandbox',
    baseUrl:
      (process.env.PAYPAL_ENVIRONMENT || 'sandbox') === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com',
  },

  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
};

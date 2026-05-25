require('dotenv').config();

const base = {
  client: 'postgresql',
  migrations: { directory: './src/db/migrations' },
  seeds:      { directory: './src/db/seeds' },
};

module.exports = {
  development: {
    ...base,
    connection: {
      host:     process.env.DB_HOST     || 'localhost',
      port:     process.env.DB_PORT     || 5432,
      database: process.env.DB_NAME     || 'paypal_qbo',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
    },
  },
  production: {
    ...base,
    // If DATABASE_URL is set (e.g. Heroku/remote PG), use it with SSL.
    // Otherwise (local Docker Compose), connect without SSL — local postgres
    // does not have SSL enabled and the ssl flag will cause the migration to fail.
    connection: process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
      : {
          host:     process.env.DB_HOST     || 'db',
          port:     process.env.DB_PORT     || 5432,
          database: process.env.DB_NAME     || 'paypal_qbo',
          user:     process.env.DB_USER     || 'postgres',
          password: process.env.DB_PASSWORD || '',
        },
    pool: { min: 2, max: 10 },
  },
};

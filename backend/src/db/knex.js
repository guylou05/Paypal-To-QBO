const knex = require('knex');
const config = require('../config');

const db = knex({
  client: 'postgresql',
  connection: {
    host:     config.db.host     || 'db',
    port:     config.db.port     || 5432,
    database: config.db.database || 'paypal_qbo',
    user:     config.db.user     || 'postgres',
    password: config.db.password || '',
  },
  pool: { min: 2, max: 10 },
  acquireConnectionTimeout: 10000,
});

module.exports = db;

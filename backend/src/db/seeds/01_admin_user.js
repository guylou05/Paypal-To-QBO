const bcrypt = require('bcryptjs');

exports.seed = async function (knex) {
  const email    = process.env.ADMIN_EMAIL    || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'changeme';

  const existing = await knex('users').where({ email }).first();
  if (existing) {
    console.log(`Admin user ${email} already exists — skipping seed.`);
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  await knex('users').insert({
    email,
    password_hash: hash,
    role:      'admin',
    is_active: true,
  });

  // Default account mapping keys (all unmapped — admin configures via UI)
  const keys = [
    'paypal_bank',
    'paypal_credit',
    'paypal_fees',
    'paypal_sales',
    'paypal_adjustments',
    'bank_account_1',
    'bank_account_2',
    'uncategorized',
  ];
  const existing_mappings = await knex('account_mappings').select('mapping_key');
  const existing_keys = existing_mappings.map(r => r.mapping_key);
  const to_insert = keys
    .filter(k => !existing_keys.includes(k))
    .map(k => ({ mapping_key: k }));

  if (to_insert.length) {
    await knex('account_mappings').insert(to_insert);
  }

  console.log(`Admin user created: ${email}`);
};

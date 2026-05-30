exports.up = async function(knex) {
  await knex.schema.createTable('payer_customer_matches', t => {
    t.increments('id').primary();
    // Normalized lookup key: payer email (preferred) or payer name (fallback), lowercased + trimmed.
    t.string('match_key').notNullable().unique();
    t.string('match_type').notNullable();     // 'email' | 'name'
    t.string('qbo_customer_id').notNullable();
    t.string('qbo_customer_name');
    // Running count so the UI can show "auto-matched (N times)" for confidence.
    t.integer('match_count').notNullable().defaultTo(1);
    t.timestamp('last_matched_at');
    t.timestamps(true, true);
  });
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('payer_customer_matches');
};

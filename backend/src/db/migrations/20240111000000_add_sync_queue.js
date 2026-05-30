exports.up = async function(knex) {
  await knex.schema
    .createTable('sync_batches', t => {
      t.increments('id').primary();
      // running → complete | partial (some failed) | failed (all failed) | cancelled
      t.string('status').notNullable().defaultTo('running');
      t.integer('total_jobs').notNullable().defaultTo(0);
      t.integer('completed_jobs').notNullable().defaultTo(0);
      t.integer('failed_jobs').notNullable().defaultTo(0);
      t.integer('created_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('completed_at');
      t.timestamps(true, true);
    })
    .createTable('sync_jobs', t => {
      t.increments('id').primary();
      t.integer('batch_id').notNullable().references('id').inTable('sync_batches').onDelete('CASCADE');
      t.integer('transaction_id').references('id').inTable('normalized_transactions').onDelete('CASCADE');
      t.string('paypal_transaction_id');
      // pending → running → completed | failed (after max_attempts exhausted) | skipped | cancelled
      t.string('status').notNullable().defaultTo('pending');
      t.integer('attempts').notNullable().defaultTo(0);
      t.integer('max_attempts').notNullable().defaultTo(3);
      t.text('error_message');
      t.jsonb('result_payload');
      t.integer('created_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('started_at');
      t.timestamp('completed_at');
      t.timestamps(true, true);
    });
};

exports.down = async function(knex) {
  await knex.schema
    .dropTableIfExists('sync_jobs')
    .dropTableIfExists('sync_batches');
};

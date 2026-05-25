exports.up = async function (knex) {
  await knex.schema

    .createTable('users', t => {
      t.increments('id').primary();
      t.string('email').notNullable().unique();
      t.string('password_hash').notNullable();
      t.string('role').notNullable().defaultTo('admin');
      t.boolean('is_active').notNullable().defaultTo(true);
      t.timestamps(true, true);
    })

    .createTable('settings', t => {
      t.increments('id').primary();
      t.string('key').notNullable().unique();
      t.text('value');
      t.string('value_type').notNullable().defaultTo('string'); // string | json | boolean
      t.timestamps(true, true);
    })

    .createTable('oauth_tokens', t => {
      t.increments('id').primary();
      t.string('provider').notNullable(); // paypal | quickbooks
      t.string('realm_id');               // QBO company ID
      t.text('access_token_encrypted').notNullable();
      t.text('refresh_token_encrypted');
      t.timestamp('access_token_expires_at');
      t.timestamp('refresh_token_expires_at');
      t.jsonb('token_metadata');           // non-sensitive metadata only
      t.timestamps(true, true);
    })

    .createTable('account_mappings', t => {
      t.increments('id').primary();
      // mapping_key values: paypal_bank, paypal_credit, paypal_fees,
      //   paypal_sales, paypal_adjustments, bank_account_1, bank_account_2, uncategorized
      t.string('mapping_key').notNullable().unique();
      t.string('qbo_account_id');
      t.string('qbo_account_name');
      t.string('qbo_account_type');
      t.timestamps(true, true);
    })

    .createTable('import_batches', t => {
      t.increments('id').primary();
      t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
      t.date('start_date').notNullable();
      t.date('end_date').notNullable();
      t.string('status').notNullable().defaultTo('pending'); // pending|running|complete|failed
      t.integer('total_fetched').defaultTo(0);
      t.integer('total_new').defaultTo(0);
      t.integer('total_duplicate').defaultTo(0);
      t.jsonb('summary');   // per-category counts
      t.text('error_message');
      t.timestamps(true, true);
    })

    .createTable('raw_paypal_transactions', t => {
      t.increments('id').primary();
      t.integer('batch_id').references('id').inTable('import_batches').onDelete('SET NULL');
      t.string('paypal_transaction_id').notNullable().unique();
      t.jsonb('raw_payload').notNullable();
      t.timestamps(true, true);
    })

    .createTable('normalized_transactions', t => {
      t.increments('id').primary();
      t.integer('raw_transaction_id').references('id').inTable('raw_paypal_transactions').onDelete('CASCADE');
      t.integer('batch_id').references('id').inTable('import_batches').onDelete('SET NULL');
      t.string('paypal_transaction_id').notNullable().unique();
      t.date('transaction_date');
      t.timestamp('transaction_datetime');
      t.string('payer_name');
      t.string('payer_email');
      t.text('description');
      t.string('event_code');    // T0006, T1201, etc.
      t.string('status_code');   // S, P, D, R, etc.
      t.decimal('gross_amount', 15, 2).defaultTo(0);
      t.decimal('fee_amount', 15, 2).defaultTo(0);
      t.decimal('net_amount', 15, 2).defaultTo(0);
      t.string('currency').defaultTo('USD');
      t.string('instrument_type');  // PAYPAL, BANK, CREDIT
      t.string('instrument_sub_type');
      t.string('funding_source');
      // Classification
      t.string('category');        // sale|paypal_fee|paypal_credit_purchase|paypal_credit_repayment|
                                   // bank_transfer_in|bank_transfer_out|refund|noise|unknown
      t.string('status').notNullable().defaultTo('imported');
      //   imported → classified → needs_review → approved → synced | ignored | failed
      t.string('confidence');      // high|medium|low
      t.string('suggested_qbo_account_key');
      t.string('override_category');
      t.string('override_qbo_account_key');
      // QBO sync
      t.string('qbo_object_id');
      t.string('qbo_object_type'); // JournalEntry|Transfer|Purchase|RefundReceipt
      t.string('qbo_sync_token');  // for updates/deletes
      // Review
      t.text('reviewer_notes');
      t.integer('reviewed_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamp('reviewed_at');
      // Relationships
      t.string('related_paypal_transaction_id'); // refund → original
      t.timestamps(true, true);
    })

    .createTable('classification_rules', t => {
      t.increments('id').primary();
      t.string('name').notNullable();
      t.string('match_field').notNullable();  // description|event_code|payer_name|payer_email|amount_op
      t.string('match_type').notNullable();   // contains|equals|starts_with|ends_with|regex
      t.string('match_value').notNullable();
      t.string('category').notNullable();
      t.string('qbo_account_key');
      t.string('confidence').defaultTo('high');
      t.integer('priority').defaultTo(50);   // lower = higher priority
      t.boolean('is_active').defaultTo(true);
      t.timestamps(true, true);
    })

    .createTable('qbo_sync_logs', t => {
      t.increments('id').primary();
      t.integer('transaction_id').references('id').inTable('normalized_transactions').onDelete('SET NULL');
      t.string('paypal_transaction_id');
      t.string('action').notNullable();       // create|delete|retry
      t.string('qbo_object_type');
      t.string('qbo_object_id');
      t.string('status').notNullable();       // success|failed
      t.text('request_payload');
      t.text('response_payload');
      t.text('error_message');
      t.integer('performed_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamps(true, true);
    })

    .createTable('rollback_logs', t => {
      t.increments('id').primary();
      t.integer('transaction_id').references('id').inTable('normalized_transactions').onDelete('SET NULL');
      t.string('paypal_transaction_id');
      t.string('qbo_object_type');
      t.string('qbo_object_id');
      t.string('action').notNullable(); // delete
      t.string('status').notNullable(); // success|failed
      t.text('error_message');
      t.integer('performed_by').references('id').inTable('users').onDelete('SET NULL');
      t.timestamps(true, true);
    })

    .createTable('audit_logs', t => {
      t.increments('id').primary();
      t.integer('user_id').references('id').inTable('users').onDelete('SET NULL');
      t.string('action').notNullable();   // import|classify|approve|sync|rollback|login|settings_update
      t.string('entity_type');            // transaction|batch|settings|account_mapping
      t.string('entity_id');
      t.jsonb('before_state');
      t.jsonb('after_state');
      t.text('details');
      t.string('ip_address');
      t.timestamps(true, true);
    });
};

exports.down = async function (knex) {
  await knex.schema
    .dropTableIfExists('audit_logs')
    .dropTableIfExists('rollback_logs')
    .dropTableIfExists('qbo_sync_logs')
    .dropTableIfExists('classification_rules')
    .dropTableIfExists('normalized_transactions')
    .dropTableIfExists('raw_paypal_transactions')
    .dropTableIfExists('import_batches')
    .dropTableIfExists('account_mappings')
    .dropTableIfExists('oauth_tokens')
    .dropTableIfExists('settings')
    .dropTableIfExists('users');
};

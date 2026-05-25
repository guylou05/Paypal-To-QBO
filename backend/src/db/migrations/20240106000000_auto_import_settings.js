/**
 * Seed default auto-import schedule settings into the settings table.
 * Uses onConflict().ignore() so re-running is safe (never overwrites
 * values the user has already configured).
 */
exports.up = async function (knex) {
  const defaults = [
    { key: 'auto_import_enabled',       value: 'false',     value_type: 'string' },
    { key: 'auto_import_cron',          value: '0 2 * * *', value_type: 'string' },
    { key: 'auto_import_lookback_hours',value: '48',        value_type: 'string' },
  ];

  for (const row of defaults) {
    await knex('settings')
      .insert({ ...row, created_at: new Date(), updated_at: new Date() })
      .onConflict('key').ignore();
  }
};

exports.down = async function (knex) {
  await knex('settings')
    .whereIn('key', [
      'auto_import_enabled',
      'auto_import_cron',
      'auto_import_lookback_hours',
      'auto_import_last_run_at',
      'auto_import_last_batch_id',
      'auto_import_last_run_status',
      'auto_import_last_run_error',
    ])
    .delete();
};

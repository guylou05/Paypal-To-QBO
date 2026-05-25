/**
 * Add sync_error TEXT column to normalized_transactions.
 *
 * Populated by the syncer when a QBO API call fails so the error
 * is immediately visible in the Review Queue without joining sync logs.
 * Cleared (set to NULL) on successful re-sync or rollback.
 */
exports.up = async function (knex) {
  await knex.schema.table('normalized_transactions', t => {
    t.text('sync_error').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.table('normalized_transactions', t => {
    t.dropColumn('sync_error');
  });
};

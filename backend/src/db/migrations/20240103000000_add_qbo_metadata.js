/**
 * Add qbo_metadata JSONB column to normalized_transactions.
 *
 * This stores the direction-specific QBO matching choices made
 * during manual review, used by the syncer to produce richer
 * Journal Entries with customer/vendor entity references,
 * specific income/expense accounts, and class tracking.
 *
 * Shape:
 *   {
 *     customer_id, customer_name,       // income: who paid
 *     vendor_id,   vendor_name,         // expense: who was paid
 *     income_account_id,  income_account_name,   // override income account
 *     expense_account_id, expense_account_name,  // override expense account
 *     class_id, class_name,             // optional class / department
 *     memo,                             // custom note sent to QBO
 *   }
 */
exports.up = async function (knex) {
  await knex.schema.table('normalized_transactions', t => {
    t.jsonb('qbo_metadata');
  });
};

exports.down = async function (knex) {
  await knex.schema.table('normalized_transactions', t => {
    t.dropColumn('qbo_metadata');
  });
};

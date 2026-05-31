/**
 * Extend payer_customer_matches with per-payer QBO metadata memory.
 *
 * Adds columns for vendor, expense account, income account, and QBO class so
 * the Edit Modal can pre-fill all four types of fields — not just the customer —
 * based on what the reviewer chose the last time a transaction from the same
 * payer was saved.
 *
 * Also relaxes the qbo_customer_id NOT NULL constraint so expense-only
 * transactions (no customer) can still benefit from the vendor / account memory.
 */
exports.up = async function(knex) {
  await knex.schema.table('payer_customer_matches', t => {
    t.string('qbo_vendor_id');
    t.string('qbo_vendor_name');
    t.string('expense_account_id');
    t.string('expense_account_name');
    t.string('income_account_id');
    t.string('income_account_name');
    t.string('class_id');
    t.string('class_name');
    // Allow expense-only transactions to create a memory row without a customer.
    t.string('qbo_customer_id').nullable().alter();
  });
};

exports.down = async function(knex) {
  await knex.schema.table('payer_customer_matches', t => {
    t.dropColumn('qbo_vendor_id');
    t.dropColumn('qbo_vendor_name');
    t.dropColumn('expense_account_id');
    t.dropColumn('expense_account_name');
    t.dropColumn('income_account_id');
    t.dropColumn('income_account_name');
    t.dropColumn('class_id');
    t.dropColumn('class_name');
    t.string('qbo_customer_id').notNullable().alter();
  });
};

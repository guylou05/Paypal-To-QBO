/**
 * Add mapping keys required for the SalesReceipt / RefundReceipt workflow.
 *
 *  paypal_sales_item     — QBO Service/Non-Inventory Item used as the line-item
 *                          reference on SalesReceipts and RefundReceipts.
 *                          Stored like an account: qbo_account_id = Item.Id,
 *                          qbo_account_name = Item.Name.
 *                          Without this, the syncer falls back to JournalEntry.
 *
 *  paypal_default_customer — QBO Customer used when the reviewer has not matched
 *                          a specific customer (e.g. "PayPal Customer" generic).
 *                          Stored: qbo_account_id = Customer.Id,
 *                          qbo_account_name = Customer.DisplayName.
 *                          Without this, the syncer falls back to JournalEntry.
 */
exports.up = async function (knex) {
  await knex('account_mappings')
    .insert([
      {
        mapping_key:      'paypal_sales_item',
        qbo_account_id:   null,
        qbo_account_name: null,
        qbo_account_type: 'Item',
        created_at:       new Date(),
        updated_at:       new Date(),
      },
      {
        mapping_key:      'paypal_default_customer',
        qbo_account_id:   null,
        qbo_account_name: null,
        qbo_account_type: 'Customer',
        created_at:       new Date(),
        updated_at:       new Date(),
      },
    ])
    .onConflict('mapping_key')
    .ignore();
};

exports.down = async function (knex) {
  await knex('account_mappings')
    .whereIn('mapping_key', ['paypal_sales_item', 'paypal_default_customer'])
    .delete();
};

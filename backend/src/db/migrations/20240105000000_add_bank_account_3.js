/**
 * Add bank_account_3 to account_mappings so up to 3 PayPal-connected
 * bank accounts can be configured for transfer matching.
 */
exports.up = async function (knex) {
  await knex('account_mappings')
    .insert({ mapping_key: 'bank_account_3', created_at: new Date(), updated_at: new Date() })
    .onConflict('mapping_key').ignore();
};

exports.down = async function (knex) {
  await knex('account_mappings').where({ mapping_key: 'bank_account_3' }).delete();
};

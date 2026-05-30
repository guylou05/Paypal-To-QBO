/**
 * Add multi-condition support to classification_rules.
 *
 * - conditions      JSONB   — array of {match_field, match_type, match_value}
 * - conditions_operator TEXT — 'and' | 'or'  (default 'and')
 *
 * Existing single-condition rules are migrated into the conditions array so
 * the classifier only needs to look at one place.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('classification_rules', t => {
    t.jsonb('conditions').nullable();
    t.string('conditions_operator', 10).notNullable().defaultTo('and');
  });

  // Migrate every existing rule into the new array format.
  const rules = await knex('classification_rules')
    .select('id', 'match_field', 'match_type', 'match_value');

  for (const rule of rules) {
    if (rule.match_field && rule.match_type && rule.match_value !== undefined) {
      await knex('classification_rules').where({ id: rule.id }).update({
        conditions: JSON.stringify([{
          match_field: rule.match_field,
          match_type:  rule.match_type,
          match_value: rule.match_value,
        }]),
      });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('classification_rules', t => {
    t.dropColumn('conditions');
    t.dropColumn('conditions_operator');
  });
};

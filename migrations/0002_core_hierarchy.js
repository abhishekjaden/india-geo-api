/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('states', {
    id: 'id',
    name: { type: 'text', notNull: true },
  });
  pgm.addConstraint('states', 'states_name_key', { unique: ['name'] });

  pgm.createTable('districts', {
    id: 'id',
    state_id: { type: 'integer', notNull: true, references: 'states', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
  });
  pgm.addConstraint('districts', 'districts_name_state_key', { unique: ['name', 'state_id'] });
  pgm.createIndex('districts', 'state_id');

  pgm.createTable('subdistricts', {
    id: 'id',
    district_id: { type: 'integer', notNull: true, references: 'districts', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
  });
  pgm.addConstraint('subdistricts', 'subdistricts_name_district_key', { unique: ['name', 'district_id'] });
  pgm.createIndex('subdistricts', 'district_id');

  pgm.createTable('villages', {
    id: 'id',
    subdistrict_id: { type: 'integer', notNull: true, references: 'subdistricts', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
  });
  pgm.createIndex('villages', 'subdistrict_id');
  // Trigram GIN index powers the fuzzy autocomplete (pg_trgm).
  pgm.sql('CREATE INDEX idx_villages_name_trgm ON villages USING gin (name gin_trgm_ops);');
};
exports.down = (pgm) => {
  pgm.dropTable('villages');
  pgm.dropTable('subdistricts');
  pgm.dropTable('districts');
  pgm.dropTable('states');
};

/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('search_logs', {
    id: 'id',
    query: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('search_logs', 'created_at');
};
exports.down = (pgm) => {
  pgm.dropTable('search_logs');
};

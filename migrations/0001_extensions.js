/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createExtension('pg_trgm', { ifNotExists: true });
  pgm.createExtension('postgis', { ifNotExists: true });
};
exports.down = (pgm) => {
  pgm.dropExtension('postgis', { ifExists: true });
  pgm.dropExtension('pg_trgm', { ifExists: true });
};

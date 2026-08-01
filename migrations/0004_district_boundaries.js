/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('district_boundaries', {
    id: 'id',
    district: { type: 'text', notNull: true },
    state: { type: 'text', notNull: true },
    st_cen_cd: { type: 'integer' },
    dt_cen_cd: { type: 'integer' },
    censuscode: { type: 'integer' },
    geom: { type: 'geometry(MultiPolygon, 4326)', notNull: true },
  });
  // GiST spatial index powers exact point-in-polygon reverse geocoding (PostGIS).
  pgm.sql('CREATE INDEX idx_district_boundaries_geom ON district_boundaries USING gist (geom);');
};
exports.down = (pgm) => {
  pgm.dropTable('district_boundaries');
};

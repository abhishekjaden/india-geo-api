// openapi.js — OpenAPI 3.0 spec for the India Geo API.
// Served as interactive Swagger UI at /api-docs (see server.js).

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'India Geo API',
    version: '1.0.0',
    description:
      "REST API for India's administrative geography — 580,398 villages across a " +
      'state → district → subdistrict → village hierarchy, with trigram fuzzy ' +
      'autocomplete and a natural-language query endpoint.',
  },
  servers: [
    { url: 'https://india-geo-api-1.onrender.com', description: 'Production' },
    { url: 'http://localhost:3000', description: 'Local development' },
  ],
  tags: [
    { name: 'Search', description: 'Fuzzy and natural-language search' },
    { name: 'Hierarchy', description: 'Browse the administrative hierarchy' },
    { name: 'Meta', description: 'Health and analytics' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Meta'],
        summary: 'Service health',
        description: 'Returns service status and uptime in seconds.',
        responses: {
          200: {
            description: 'Service is up',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    uptime: { type: 'number', example: 1234.5 },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/autocomplete': {
      get: {
        tags: ['Search'],
        summary: 'Fuzzy village search',
        description:
          'Trigram-based fuzzy search over ~580k village names. Requires at least ' +
          '2 characters and rejects queries longer than 60 characters. Returns up ' +
          'to 10 matches ranked by similarity.',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string', minLength: 2, maxLength: 60 },
            example: 'mangalore',
          },
        ],
        responses: {
          200: {
            description: 'Matching villages',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        example: 'Mangalore, Tittakudi, Cuddalore, TAMIL NADU',
                      },
                      value: { type: 'string', example: 'Mangalore' },
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Query too long (over 60 characters)' },
        },
      },
    },
    '/ask': {
      get: {
        tags: ['Search'],
        summary: 'Natural-language query',
        description:
          'Answers a plain-English question about the dataset. The model returns a ' +
          'structured intent, which the server maps to safe parameterized SQL — the ' +
          'model never writes SQL directly.',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string', maxLength: 200 },
            example: 'How many villages are in Kerala?',
          },
        ],
        responses: {
          200: {
            description: 'Answer with the interpreted intent',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    question: { type: 'string' },
                    answer: { type: 'string', example: 'There are 1495 villages in Kerala.' },
                    intent: { type: 'object' },
                    supported: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: { description: 'Missing or too-long question' },
          503: { description: 'AI service temporarily unavailable' },
        },
      },
    },
    '/parse-address': {
      post: {
        tags: ['Search'],
        summary: 'AI address parser / normalizer',
        description:
          'Extracts the administrative components from a messy free-text Indian ' +
          'address, then validates each against the real database top-down through ' +
          'the hierarchy. Every returned field is verified against real data.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['address'],
                properties: {
                  address: {
                    type: 'string',
                    maxLength: 500,
                    example: 'ramesh kumar, near temple, tittakudi, cuddalore dist tamilnadu',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Parsed and verified address',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    input: { type: 'string' },
                    extracted: { type: 'object', description: 'Raw components from the model' },
                    verified: { type: 'object', description: 'Canonical names matched in the DB (or null)' },
                    scores: { type: 'object', description: 'Trigram similarity per matched level' },
                    complete: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: { description: 'Missing or too-long address' },
          503: { description: 'Parser temporarily unavailable' },
        },
      },
    },
'/reverse-geocode': {
      get: {
        tags: ['Search'],
        summary: 'Reverse geocode a coordinate',
        description:
          'Given a latitude/longitude, returns the Indian district and state whose ' +
          'boundary contains the point — exact point-in-polygon via PostGIS over a ' +
          'GiST spatial index. For a point outside every boundary (e.g. offshore), ' +
          'returns the nearest district with "exact": false. District boundaries are ' +
          '2011 census vintage, so post-2011 splits and Telangana are not separated out.',
        parameters: [
          {
            name: 'lat',
            in: 'query',
            required: true,
            schema: { type: 'number', minimum: -90, maximum: 90 },
            example: 13.0827,
          },
          {
            name: 'lng',
            in: 'query',
            required: true,
            schema: { type: 'number', minimum: -180, maximum: 180 },
            example: 80.2707,
          },
        ],
        responses: {
          200: {
            description: 'District and state for the point',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    lat: { type: 'number', example: 13.0827 },
                    lng: { type: 'number', example: 80.2707 },
                    district: { type: 'string', example: 'Chennai' },
                    state: { type: 'string', example: 'Tamil Nadu' },
                    exact: {
                      type: 'boolean',
                      description:
                        'true if the point falls inside a district polygon; ' +
                        'false if the nearest district was returned instead',
                      example: true,
                    },
                  },
                },
              },
            },
          },
          400: { description: 'Missing or out-of-range coordinates' },
          404: { description: 'No district found' },
        },
      },
    },
    '/states': {
      get: {
        tags: ['Hierarchy'],
        summary: 'List states',
        description: 'All states and union territories.',
        responses: { 200: { description: 'List of states' } },
      },
    },
    '/districts': {
      get: {
        tags: ['Hierarchy'],
        summary: 'List districts in a state',
        parameters: [
          { name: 'state_id', in: 'query', required: true, schema: { type: 'integer' }, example: 1 },
        ],
        responses: { 200: { description: 'Districts in the given state' } },
      },
    },
    '/subdistricts': {
      get: {
        tags: ['Hierarchy'],
        summary: 'List subdistricts in a district',
        parameters: [
          { name: 'district_id', in: 'query', required: true, schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Subdistricts in the given district' } },
      },
    },
    '/villages': {
      get: {
        tags: ['Hierarchy'],
        summary: 'List villages in a subdistrict',
        parameters: [
          { name: 'subdistrict_id', in: 'query', required: true, schema: { type: 'integer' } },
        ],
        responses: { 200: { description: 'Villages in the given subdistrict' } },
      },
    },
    '/stats': {
      get: {
        tags: ['Meta'],
        summary: 'Search analytics',
        description: 'Total search count and the most frequent search queries.',
        responses: {
          200: {
            description: 'Analytics',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total_searches: { type: 'integer', example: 1284 },
                    top_searches: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          query: { type: 'string' },
                          count: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SimpleCache } = require('../cache');

describe('bounded public metadata cache', () => {
  it('evicts least-recently-used entries when count or bytes are reached', () => {
    const cache = new SimpleCache({ maxEntries: 2, maxBytes: 8 });
    cache.set('a', { body: '1234', contentType: 'text/plain' });
    cache.set('b', { body: '5678', contentType: 'text/plain' });
    assert.equal(cache.get('a').body, '1234');
    cache.set('c', { body: 'abcd', contentType: 'text/plain' });
    assert.equal(cache.get('a').body, '1234');
    assert.equal(cache.get('b'), null);
    assert.equal(cache.get('c').body, 'abcd');
    assert.equal(cache._sizeBytes <= 8, true);
    assert.equal(cache._map.size <= 2, true);
  });

  it('does not retain a single entry larger than its total byte budget', () => {
    const cache = new SimpleCache({ maxEntries: 2, maxBytes: 4 });
    assert.equal(cache.set('large', { body: '12345' }), false);
    assert.equal(cache.get('large'), null);
  });
});

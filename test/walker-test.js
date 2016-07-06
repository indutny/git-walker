'use strict';
/* global describe it */

const assert = require('assert');
const path = require('path');

const Walker = require('../');

describe('git-walker', () => {
  const walker = new Walker(path.join(__dirname, '..'));

  describe('.resolveObject', () => {
    it('should find commit by 7 letters', (cb) => {
      walker.resolveObject('de4190e', (err, hash) => {
        if (err)
          return cb(err);

        assert.equal(hash, 'de4190e34c8335c9113d70873b5253395ee6e62e');
        cb();
      });
    });

    it('should not find invalid commit', (cb) => {
      walker.resolveObject('dead', (err, hash) => {
        assert(err);
        assert(!hash);
        cb();
      });
    });

    it('should not find ambigous commit', (cb) => {
      walker.resolveObject('de', (err, hash) => {
        assert(/Ambigous/.test(err.message));
        assert(!hash);
        cb();
      });
    });
  });

  describe('.resolveRef', () => {
    it('should find HEAD', (cb) => {
      walker.resolveRef('HEAD', (err, hash) => {
        if (err)
          return cb(err);

        assert(/^[a-z0-9]{40}$/.test(hash));
        cb();
      });
    });

    it('should resolve `objects/...` ref as it is', (cb) => {
      walker.resolveRef(
        'objects/ed/4eebe254f6f41600daf2c6d05b768372dea3f4',
        (err, hash) => {
          assert(!err);
          assert.equal(hash, 'ed4eebe254f6f41600daf2c6d05b768372dea3f4');
          cb(null);
        }
      );
    });

    it('should not find invalid ref', (cb) => {
      walker.resolveRef('dead', (err, hash) => {
        assert(err);
        assert(!hash);
        cb();
      });
    });
  });

  it('should walk this tree', (cb) => {
    const walker = new Walker(path.join(__dirname, '..'));

    const hashes = [];
    const headers = [];
    const types = [];
    const bodies = {};
    const stream = walker.visit('de4190e');

    stream.on('data', (object) => {
      hashes.push(object.hash);
      headers.push(object.header);
      types.push(object.type);

      bodies[object.hash] = object.body;
    });
    stream.on('end', () => {
      assert.deepEqual(headers, [
        'commit 174',
        'tree 139',
        'blob 28',
        'tree 37',
        'blob 224',
        'blob 723',
        'tree 42',
        'blob 380'
      ]);

      assert.deepEqual(types, [
        'commit',
        'tree',
        'blob',
        'tree',
        'blob',
        'blob',
        'tree',
        'blob'
      ]);

      let chunks = '';
      const ignore = bodies['1ca957177f035203810612d1d93a66b08caff296'];
      ignore.on('data', chunk => chunks += chunk);
      ignore.on('end', () => {
        assert.equal(chunks, 'node_modules/\nnpm-debug.log\n');
        cb();
      });
    });
  });
});

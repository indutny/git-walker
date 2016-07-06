'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const async = require('async');
const binarySearch = require('binary-search');
const OffsetBuffer = require('obuf');

function PackedIndex(db) {
  this.pack = path.join(db, 'objects', 'pack');
  this.index = [];

  this.initialized = false;
  this.queue = [];

  this.init((err) => {
    this.initialized = !err;

    const queue = this.queue;
    this.queue = null;

    queue.forEach(err ? entry => entry.fail(err) : entry => entry.next());
  });
}
module.exports = PackedIndex;

PackedIndex.prototype.init = function init(callback) {
  fs.exists(this.pack, (exists) => {
    // Empty index
    if (!exists)
      return callback(null);

    async.waterfall([
      (callback) => fs.readdir(this.pack, callback),
      (entries, callback) => {
        const idx = entries.filter(name => /\.idx$/.test(name));

        async.map(idx, (file, callback) => {
          this.loadIdx(file, callback);
        }, callback);
      },
      (idxs, callback) => {
        this.index = idxs;
        callback(null);
      }
    ], callback);
  });
};

const PACK_V2_MAGIC = 0xff744f63;

PackedIndex.prototype.loadIdx = function loadIdx(file, callback) {
  async.waterfall([
    (callback) => fs.readFile(path.join(this.pack, file), callback),
    (content, callback) => {
      let parsed;
      try {
        parsed = this.parseIdx(file.slice(0, -4), content);
      } catch (e) {
        return callback(e);
      }

      callback(null, parsed);
    }
  ], callback);
};

PackedIndex.prototype.parseIdx = function parseIdx(hash, content) {
  const b = new OffsetBuffer();
  b.push(content);

  assert.equal(b.readUInt32BE(), PACK_V2_MAGIC,
               'v1 pack files are not supported');
  assert.equal(b.readUInt32BE(), 2, 'Only v2 pack files are supported');

  // Skip the most of the fanout
  b.skip(255 * 4);

  const total = b.readUInt32BE();
  const objects = new Array(total);
  for (let i = 0; i < total; i++)
    objects[i] = b.take(20).toString('hex');

  // Skip checksums
  b.skip(4 * total);

  const offsets = new Array(total);
  for (let i = 0; i < total; i++)
    offsets[i] = b.readUInt32BE();

  let off = 0;
  for (let i = 0; i < total; i++) {
    if ((offsets[i] & 0x80000000) === 0)
      continue;

    const suboff = offsets[i] & 0x7fffffff;
    if (suboff !== off)
      throw new Error('64-bit pack offsets are out-of-order');

    // No chance to support 64-bit integers easily here, but 52bit should be
    // fine
    offsets[i] = (b.readUInt32BE() * 0x100000000) +
                 b.readUInt32BE();
    off++;
  }

  return { hash: hash, objects: objects, offsets: offsets };
};

PackedIndex.prototype.runAfterInit = function runAfterInit(next, fail) {
  this.queue.push({
    next: next,
    fail: fail
  });
};

function lookupCompare(a, b) {
  return a === b ? 0 : a > b ? 1 : -1;
}

const TYPES = [
  'none',  // 0
  'commit',
  'tree',
  'blob',
  'tag',
  'obs_delta',
  'ref_delta'
];

PackedIndex.prototype.lookup = function lookup(hash, callback) {
  if (!this.initialized) {
    this.runAfterInit(() => this.lookup(hash, callback), callback);
    return;
  }

  let res = null;
  for (let i = 0; i < this.index.length; i++) {
    const idx = this.index[i];

    const subres = binarySearch(idx.objects, hash, lookupCompare);
    if (subres < 0)
      continue;

    res = { pack: idx.hash, offset: idx.offsets[subres] };
    break;
  }

  if (res === null)
    return callback(new Error(`Object not found ${hash}`));

  const file = path.join(this.pack, res.pack + '.pack');

  async.waterfall([
    (callback) => {
      fs.open(file, 'r', callback);
    },
    (fd, callback) => {
      const buf = Buffer.alloc(8);
      fs.read(fd, buf, 0, buf.length, res.offset,
              (err) => callback(err, fd, buf));
    },
    (fd, buf, callback) => {
      const type = TYPES[(buf[0] >> 4) & 0x7];
      let size = buf[0] & 0xf;
      let p = 16;

      // Again, not nearly 64 bits, but 52 should be enough
      let i;
      for (i = 1; (buf[i - 1] & 0x80) !== 0 && i < buf.length; i++) {
        size += (buf[i] & 0x7f) * p;
        p *= 128;
      }
      if (i === buf.length) {
        fs.close(fd);
        return callback(new Error('Pack object size OOB'));
      }

      if (type === 'obs_delta' || type === 'ref_delta') {
        fs.close(fd);
        return callback(new Error('Not supported'));
      }

      // NOTE: `size` is a size of decompressed data, and can't be used here
      const rawBody = fs.createReadStream(file, {
        fd: fd,
        start: res.offset + i
      })
      const inflate = new zlib.Inflate();
      rawBody.pipe(inflate);
      inflate.once('end', () => {
        rawBody.unpipe(inflate);
        rawBody.destroy();
      });

      callback(null, type + ' ' + size, inflate);
    }
  ], callback);
};

function resolveCompare(item, needle) {
  if (item.startsWith(needle))
    return 0;

  return item > needle ? 1 : -1;
}

PackedIndex.prototype.resolve = function resolve(hash, callback) {
  if (!this.initialized) {
    this.runAfterInit(() => this.resolve(hash, callback), callback);
    return;
  }

  let res = null;
  for (let i = 0; i < this.index.length; i++) {
    const idx = this.index[i];

    const subres = binarySearch(idx.objects, hash, resolveCompare);
    if (subres < 0)
      continue;

    // TODO(indutny): go to the left and to the right
    if (res !== null)
      return callback(new Error(`Ambigous hash "${hash}"`));

    res = idx.objects[subres];
  }

  if (res === null)
    return callback(new Error(`Object not found ${hash}`));

  callback(null, res);
};

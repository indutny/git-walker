'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const stream = require('stream');

const async = require('async');
const binarySearch = require('binary-search');
const OffsetBuffer = require('obuf');

const Delta = require('./delta');

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
  null,
  'ofs_delta',
  'ref_delta'
];

function parseTypeSize(buf) {
  assert(buf.has(1));
  let prev = buf.readUInt8();
  const type = TYPES[(prev >> 4) & 0x7];
  let size = prev & 0xf;
  let p = 16;

  // Again, not nearly 64 bits, but 52 should be enough
  while ((prev & 0x80) !== 0) {
    assert(buf.has(1));

    const next = buf.readUInt8();
    size += (next & 0x7f) * p;
    p *= 128;
    prev = next;
  }

  return { type: type, size: size };
}

function parseVarInt(buf) {
  assert(buf.has(1));
  let prev = buf.readUInt8();
  let res = prev & 0x7f;
  while ((prev & 0x80) !== 0) {
    assert(buf.has(1));
    const next = buf.readUInt8();

    res++;
    res *= 128;
    res += next & 0x7f;
    prev = next;
  }

  return res;
}

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

    res = { idx: idx, offset: idx.offsets[subres] };
    break;
  }

  if (res === null)
    return callback(new Error(`Object not found ${hash}`));

  return this._lookup(res.idx, res.offset, callback);
};

PackedIndex.prototype._lookup = function _lookup(idx, offset, callback) {
  const file = path.join(this.pack, idx.hash + '.pack');

  fs.open(file, 'r', (err, fd) => {
    if (err)
      return callback(err);

    async.waterfall([
      (callback) => {
        const buf = Buffer.alloc(32);
        fs.read(fd, buf, 0, buf.length, offset,
                (err) => callback(err, buf));
      },
      (buf, callback) => {
        const b = new OffsetBuffer();
        b.push(buf);

        const typeSize = parseTypeSize(b);
        const type = typeSize.type;
        const size = typeSize.size;

        let extra = null;
        if (type === 'ref_delta') {
          extra = b.take(20).toString('hex');
          extra = binarySearch(idx.objects, extra, lookupCompare);
          if (extra < 0) {
            return callback(
              new Error(`ref_delta reference not found ${extra}`));
          }

          extra = idx.offsets[extra];
        } else if (type === 'ofs_delta') {
          const delta = parseVarInt(b);

          extra = offset - delta;
        }

        // NOTE: `size` is a size of decompressed data, and can't be used here
        const rawBody = fs.createReadStream(file, {
          fd: fd,
          start: offset + b.offset
        });
        const inflate = new zlib.Inflate();
        rawBody.pipe(inflate);

        // Unpipe as soon as we can
        inflate.once('end', () => {
          rawBody.unpipe(inflate);
          rawBody.destroy();
        });

        if (type === 'ofs_delta' || type === 'ref_delta')
          this.resolveDelta(inflate, idx, extra, callback);
        else
          callback(null, type, size, inflate);
      }
    ], (err, type, size, body) => {
      if (err)
        fs.close(fd);

      callback(err, type, size, body);
    });
  });
};

// TODO(indutny): move to common.js
function collect(stream, callback) {
  const out = [];
  stream.on('data', chunk => out.push(chunk));
  stream.on('end', () => callback(null, Buffer.concat(out)));
  stream.on('error', (err) => callback(err));
}

PackedIndex.prototype.resolveDelta = function resolveDelta(content, idx, off,
                                                           callback) {
  async.waterfall([
    (callback) => {
      async.parallel({
        delta: (callback) => collect(content, callback),
        parent: (callback) => this._lookup(idx, off, callback)
      }, callback);
    },
    (res, callback) => {
      collect(res.parent[2], (err, body) => {
        res.parent[2] = body;
        callback(err, res);
      });
    }
  ], (err, result) => {
    if (err)
      return callback(err);

    const delta = new Delta();
    let patched;
    try {
      patched = delta.patch(result.parent[2], result.delta);
    } catch (e) {
      return callback(e);
    }

    const body = new stream.PassThrough();
    body.end(patched);
    callback(null, result.parent[0], patched.length, body);
  });
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

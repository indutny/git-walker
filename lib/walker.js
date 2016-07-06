'use strict';

const fs = require('fs');
const path = require('path');
const stream = require('stream');
const zlib = require('zlib');

const async = require('async');

const GitObject = require('./git-object');
const PackedIndex = require('./packed-index');

function Walker(repo) {
  this.repo = repo;
  this.db = path.join(repo, '.git');

  this.packedIndex = null;
}
module.exports = Walker;

Walker.prototype.resolvePackedObject = function resolvePackedObject(hash,
                                                                    callback) {
  if (!this.packedIndex)
    this.packedIndex = new PackedIndex(this.db);

  this.packedIndex.resolve(hash, callback);
};

Walker.prototype.resolveLooseObject = function resolveLooseObject(hash,
                                                                  callback) {
  const head = hash.slice(0, 2);
  const tail = hash.slice(2);

  const objects = path.join(this.db, 'objects', head);
  fs.readdir(objects, (err, files) => {
    if (err)
      return callback(err);

    let res;
    for (let i = 0; i < files.length; i++) {
      if (!files[i].startsWith(tail))
        continue;

      if (res)
        return callback(new Error(`Ambigous hash "${hash}"`));

      res = head + files[i];
    }

    if (res)
      return callback(null, res);
    callback(new Error(`Object not found ${hash}`));
  });
};

Walker.prototype.resolveObject = function resolveObject(hash, callback) {
  if (hash.length < 4)
    return callback(new Error(`Ambigous hash "${hash}"`));

  this.resolvePackedObject(hash, (err, object) => {
    if (!err)
      return callback(null, object);

    this.resolveLooseObject(hash, callback);
  });
};

Walker.prototype.parseSymref = function parseSymref(str) {
  let match = str.match(/^ref:\s+([^\s]*)\s*$/);
  if (match !== null)
    return match[1];

  match = str.match(/([a-z0-9]{40})/);
  if (match === null)
    throw new Error(`Invalid symref ${str}`);

  return path.join('objects', match[1].slice(0, 2), match[2].slice(2));
};

Walker.prototype.resolveHead = function resolveHead(callback) {
  fs.readFile(path.join(this.db, 'HEAD'), (err, ref) => {
    if (err)
      return callback(err);

    ref = this.parseSymref(ref.toString());
    this.resolveRef(ref, callback);
  });
};

Walker.prototype.resolvePackedRef = function resolvePackedRef(ref, callback) {
  const packed = path.join(this.db, 'packed-refs');

  fs.readFile(packed, (err, content) => {
    if (err)
      return callback(err);

    let match;
    const found = content.toString().split(/\n/g).some((line) => {
      if (!line.endsWith(ref))
        return false;

      match = line.split(' ', 1)[0];
      return true;
    });

    if (!found)
      return callback(new Error(`Unknown ref ${ref}`));

    callback(null, match);
  });
};

Walker.prototype.resolveRef = function resolveRef(ref, callback) {
  if (ref === 'HEAD')
    return this.resolveHead(callback);

  if (!/^refs\//.test(ref)) {
    this.resolveRef(`refs/tags/${ref}`, (err, result) => {
      if (!err)
        return callback(null, result);

      this.resolveRef(`refs/heads/${ref}`, callback);
    });
    return;
  }

  async.waterfall([
    (callback) => {
      fs.exists(path.join(this.db, ref), exists => callback(null, exists));
    },
    (exists, callback) => {
      if (exists)
        fs.readFile(path.join(this.db, ref), callback)
      else
        this.resolvePackedRef(ref, callback);
    }
  ], (err, out) => {
    if (err)
      return callback(err);

    /* Trim `\n`, just in case */
    return callback(null, out.toString().trim());
  });
};

Walker.prototype.resolve = function resolve(name, callback) {
  this.resolveRef(name, (err, out) => {
    if (!err)
      return callback(null, out);

    this.resolveObject(name, callback);
  });
};

Walker.prototype.getPackedObject = function getPackedObject(hash, callback) {
  if (!this.packedIndex)
    this.packedIndex = new PackedIndex(this.db);

  this.packedIndex.lookup(hash, callback);
};

Walker.prototype.getLooseObject = function getLooseObject(hash, callback) {
  const head = hash.slice(0, 2);
  const tail = hash.slice(2);

  const file = fs.createReadStream(path.join(this.db, 'objects', head, tail));
  const inflate = new zlib.Inflate();

  file.on('error', (err) => callback(err));
  inflate.on('error', (err) => callback(err));

  let header = '';
  const onReadable = () => {
    const chunk = inflate.read();
    if (!chunk)
      return;

    let i;
    for (i = 0; i < chunk.length; i++)
      if (chunk[i] === 0)
        break;

    if (i === chunk.length) {
      header += chunk;
      return;
    }

    header += chunk.slice(0, i);
    inflate.removeListener('readable', onReadable);
    inflate.unshift(chunk.slice(i + 1));

    callback(null, header, inflate);
  };
  inflate.on('readable', onReadable);

  file.pipe(inflate);
};

Walker.prototype.getObject = function getObject(hash, callback) {
  this.getPackedObject(hash, (err, header, body) => {
    if (!err)
      return callback(null, header, body);

    this.getLooseObject(hash, callback);
  });
};

Walker.prototype.visit = function visit(ref) {
  const res = new stream.PassThrough({ objectMode: true });

  this.resolve(ref, (err, hash) => {
    if (err)
      return res.emit('error', err);

    this._visitCommit(hash, res, (err) => {
      if (err)
        return res.emit('error', err);

      res.end();
    });
  });

  return res;
};

function copyBody(body, callback) {
  const copy = new stream.PassThrough();

  body.pipe(copy);

  let chunks = [];
  body.on('data', chunk => chunks.push(chunk));
  body.on('end', () => callback(null, Buffer.concat(chunks)));

  return copy;
}

function drainWrap(stream, callback) {
  let args;
  let drained = false;

  stream.once('drain', () => {
    if (args === undefined) {
      drained = true;
      return;
    }

    callback.apply(this, args);
  });

  return function() {
    if (drained)
      return callback.apply(this, arguments);

    args = arguments;
  };
}

Walker.prototype._visitCommit = function _visitCommit(hash, stream, callback) {
  this.getObject(hash, (err, header, body) => {
    if (err)
      return callback(err);

    body = copyBody(body, (err, body) => {
      if (err)
        return callback(err);

      const match = body.toString().match(/(?:^|[\r\n])tree ([a-z0-9]{40})/);
      if (match === null)
        return callback(new Error(`Failed to parse commit body: ${body}`));

      const tree = match[1];
      this._visitTree(tree, stream, callback);
    });

    if (!stream.write(new GitObject(hash, header, body)))
      callback = drainWrap(stream, callback);
  });
};

function parseTree(buf) {
  let off = 0;
  let entries = [];
  while (off < buf.length) {
    let i;
    for (i = off; i < buf.length; i++)
      if (buf[i] === 0x00)
        break;
    if (i + 1 >= buf.length)
      throw new Error('Tree entry\'s name not found');

    const name = buf.slice(off, i).toString();
    off = i + 1;

    if (off + 20 > buf.length)
      throw new Error('Not enough space for tree entry\'s hash');

    const hash = buf.slice(off, off + 20).toString('hex');
    off += 20;

    const parts = name.split(' ');
    entries.push({
      mode: parts[0] | 0,
      name: parts[1],
      hash: hash
    });
  }
  return entries;
}

Walker.prototype._visitTree = function _visitTree(hash, stream, callback) {
  const next = (entity, callback) => {
    if (entity.mode === 40000)
      return this._visitTree(entity.hash, stream, callback);
    else if (entity.mode === 160000)
      return this._visitSubmodule(entity.hash, stream, callback);
    else
      return this._visitBlob(entity.hash, stream, callback);
  };

  this.getObject(hash, (err, header, body) => {
    if (err)
      return callback(err);

    body = copyBody(body, (err, body) => {
      if (err)
        return callback(err);

      const tree = parseTree(body);

      async.forEachSeries(tree, next, callback);
    });

    if (!stream.write(new GitObject(hash, header, body)))
      callback = drainWrap(stream, callback);
  });
};

Walker.prototype._visitBlob = function _visitBlob(hash, stream, callback) {
  this.getObject(hash, (err, header, body) => {
    if (err)
      return callback(err);

    if (!stream.write(new GitObject(hash, header, body)))
      callback = drainWrap(stream, callback);

    callback(null);
  });
};

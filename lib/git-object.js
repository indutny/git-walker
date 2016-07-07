'use strict';

function GitObject(path, hash, type, size, body) {
  this.path = path;
  this.hash = hash;
  this.type = type;
  this.size = size;
  this.header = type + ' ' + size;
  this.body = body;
}
module.exports = GitObject;

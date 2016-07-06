'use strict';

function GitObject(hash, type, size, body) {
  this.hash = hash;
  this.type = type;
  this.size = size;
  this.header = type + ' ' + size;
  this.body = body;
}
module.exports = GitObject;

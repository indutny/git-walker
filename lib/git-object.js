'use strict';

function GitObject(hash, header, body) {
  this.hash = hash;
  this.header = header;
  this.body = body;
}
module.exports = GitObject;

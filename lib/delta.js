'use strict';

const assert = require('assert');
const Buffer = require('buffer').Buffer;

const OffsetBuffer = require('obuf');

function Delta() {
  this.buf = null;
}
module.exports = Delta;

Delta.prototype.varint = function varint() {
  let res = 0;
  let next;
  let p = 1;
  do {
    assert(this.buf.has(1));
    next = this.buf.readUInt8();

    res += (next & 0x7f) * p;
    p *= 128;
  } while ((next & 0x80) !== 0);

  return res;
};

Delta.prototype.patch = function patch(original, diff) {
  this.buf = new OffsetBuffer();
  this.buf.push(diff);

  const srcSize = this.varint();
  assert.equal(srcSize, original.length);

  const dstSize = this.varint();

  const out = Buffer.alloc(dstSize);
  let outOff = 0;

  while (!this.buf.isEmpty()) {
    const cmd = this.buf.readUInt8();
    if (cmd & 0x80) {
      let off = 0;
      let size = 0;

      if (cmd & 0x01) off |= this.buf.readUInt8();
      if (cmd & 0x02) off |= this.buf.readUInt8() << 8;
      if (cmd & 0x04) off |= this.buf.readUInt8() << 16;
      if (cmd & 0x08) off |= this.buf.readUInt8() << 24;

      if (cmd & 0x10) size |= this.buf.readUInt8();
      if (cmd & 0x20) size |= this.buf.readUInt8() << 8;
      if (cmd & 0x40) size |= this.buf.readUInt8() << 16;
      if (size === 0) size = 0x10000;

      original.copy(out, outOff, off, off + size);
      outOff += size;
    } else {
      this.buf.copy(out, outOff, 0, cmd);
      this.buf.skip(cmd);
      outOff += cmd;
    }
  }

  return out;
};

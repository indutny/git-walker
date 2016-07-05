'use strict';

const assert = require('assert');
const path = require('path');

const Walker = require('../');

describe('git-walker', () => {
  it('should walk this tree', (cb) => {
    const walker = new Walker(path.join(__dirname, '..'));

    const stream = walker.visit();
    stream.on('data', (obj) => {
      console.log(obj);
    });

    stream.on('end', cb);
  });
});

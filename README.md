# git-walker
[![NPM version](https://badge.fury.io/js/git-walker.svg)](http://badge.fury.io/js/git-walker)
[![Build Status](https://secure.travis-ci.org/indutny/gyp.js.svg)](http://travis-ci.org/indutny/gyp.js)

## Why?

There were no projects with stream support for blob's contents.

## How?

`git-walker` reads contents of `.git` folder, and operates on them.

## Usage

```javascript
const GitWalker = require('git-walker');

const walker = new GitWalker('/my/repo');

const s = walker.visit('HEAD' /* or any branch, commit, ref */);
s.on('data', (object) => {
  // object.hash
  // object.header
  // object.body
  object.body.on('data', ...);
  object.body.on('end', ...);
});
s.on('end', () => {});
```

## LICENSE

This software is licensed under the MIT License.

Copyright Fedor Indutny, 2016.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

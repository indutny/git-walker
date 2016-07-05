const fs = require('fs');
const stream = require('stream');

function Walker() {
}
module.exports = Walker;

Walker.prototype.visit = function visit() {
  const res = stream.PassThrough();
  res.push(null);
  return res;
};

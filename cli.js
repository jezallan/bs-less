#!/usr/bin/env node
console.log('BS-Less (┛◉Д◉)┛彡┻━┻');
const opts = {};

process.argv.forEach((opt) => {
  if (!opt.match(/^-+/)) return;
  const kv = opt.split('='),
        k = kv[0].replace(/-+/, '').trim(),
        v = kv[1] ? kv[1].trim() : true;
  opts[k] = v;
});

require('./')(process.argv.splice(2)[0], opts);

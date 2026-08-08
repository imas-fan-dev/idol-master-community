'use strict';

const { importMain } = require('./fudaba-metadata');

if (require.main === module) importMain();

module.exports = { main: importMain };

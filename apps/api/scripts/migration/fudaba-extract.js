'use strict';

const { extractMain } = require('./fudaba-metadata');

if (require.main === module) extractMain();

module.exports = { main: extractMain };

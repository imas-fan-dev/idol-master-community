'use strict';

const { reconcileMain } = require('./fudaba-metadata');

if (require.main === module) reconcileMain();

module.exports = { main: reconcileMain };

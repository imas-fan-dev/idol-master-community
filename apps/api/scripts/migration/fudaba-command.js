'use strict';

const {
    extractMain,
    importMain,
    reconcileMain
} = require('./fudaba-metadata');

const commands = new Map([
    ['extract', extractMain],
    ['import', importMain],
    ['reconcile', reconcileMain]
]);

async function main(argv = process.argv.slice(2), environment = process.env) {
    const [command, ...options] = argv.filter((argument) => argument !== '--');
    const action = commands.get(command);
    if (!action) {
        console.error('Usage: fudaba-command.js <extract|import|reconcile> [options]');
        process.exitCode = 1;
        return null;
    }
    return action(options, environment);
}

if (require.main === module) void main();

module.exports = { main };

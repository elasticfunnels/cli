#!/usr/bin/env node
// Entry shim: resolves the compiled CLI and runs it. Keeps the bin file tiny
// so updates to the actual command tree don't require regenerating this.
'use strict';

require('../out/extension.js').run(process.argv).catch((err) => {
    // Last-resort error handler: a thrown error here means the dispatcher
    // didn't handle it. Print a short message to stderr and exit 1.
    process.stderr.write(`ef: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(1);
});

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

// Count public filesystem operations, not underlying syscalls. Setup and assertions
// stay outside this scope so only the actual extension operation is measured.
async function measureIO(t, operation) {
    const counts = {
        reads: 0, writes: 0, stat: 0, lstat: 0, realpath: 0,
        mkdir: 0, scans: 0, fsync: 0, network: 0, sync: 0,
        readBytes: 0, writtenBytes: 0, maxPending: 0,
    };
    const mocks = [];
    let pending = 0;
    const methods = {
        readFile: 'reads', writeFile: 'writes', stat: 'stat', lstat: 'lstat',
        realpath: 'realpath', mkdir: 'mkdir', readdir: 'scans', fsync: 'fsync',
    };
    for (const [method, counter] of Object.entries(methods)) {
        const syncName = method + 'Sync';
        const sync = fs[syncName];
        mocks.push(t.mock.method(fs, syncName, function (...args) {
            counts[counter]++;
            counts.sync++;
            const result = sync.apply(this, args);
            if (method === 'readFile') counts.readBytes += Buffer.byteLength(result);
            if (method === 'writeFile') counts.writtenBytes += Buffer.byteLength(args[1]);
            return result;
        }));
        if (fs.promises[method]) {
            const originalAsync = fs.promises[method];
            mocks.push(t.mock.method(fs.promises, method, async function (...args) {
                counts[counter]++;
                pending++;
                counts.maxPending = Math.max(counts.maxPending, pending);
                try {
                    const result = await originalAsync.apply(this, args);
                    if (method === 'readFile') counts.readBytes += Buffer.byteLength(result);
                    if (method === 'writeFile') counts.writtenBytes += Buffer.byteLength(args[1]);
                    return result;
                } finally {
                    pending--;
                }
            }));
        }
    }
    for (const target of [http, https]) {
        for (const method of ['get', 'request']) {
            mocks.push(t.mock.method(target, method, () => {
                counts.network++;
                throw new Error('Unexpected network request during local rule sync');
            }));
        }
    }
    mocks.push(t.mock.method(globalThis, 'fetch', () => {
        counts.network++;
        throw new Error('Unexpected fetch during local rule sync');
    }));
    try {
        await operation();
        return counts;
    } finally {
        for (const mock of mocks) mock.mock.restore();
    }
}

module.exports = { measureIO };

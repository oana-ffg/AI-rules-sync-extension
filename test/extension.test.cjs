const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { measureIO } = require('./helpers/io.cjs');

const commands = new Map();
let workspaceFolder;
let ruleFiles;
let panel;
let warningChoice;
let warnings = [];
let inputBox;
let configUpdates = [];
let configListener;
const vscode = {
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    StatusBarAlignment: { Right: 1 },
    ViewColumn: { One: 1 },
    ConfigurationTarget: { Workspace: 2 },
    workspace: {
        get workspaceFolders() { return workspaceFolder ? [{ uri: { fsPath: workspaceFolder } }] : undefined; },
        getConfiguration() {
            return {
                get() { return ruleFiles; },
                async update(key, value, target) { configUpdates.push({ key, value, target }); },
            };
        },
        onDidChangeConfiguration(callback) { configListener = callback; return { dispose() {} }; },
    },
    window: {
        createStatusBarItem() { return { show() {}, dispose() {} }; },
        showErrorMessage() {},
        showInformationMessage() {},
        async showWarningMessage(message) { warnings.push(message); return typeof warningChoice === 'function' ? warningChoice() : warningChoice; },
        async showInputBox(options) { return inputBox(options); },
        createWebviewPanel(viewType, title, column, options) {
            panel = {
                options,
                messages: [],
                webview: {
                    onDidReceiveMessage(callback) { panel.receive = callback; },
                    postMessage(message) { panel.messages.push(message); },
                },
                onDidDispose(callback) { this.onDispose = callback; },
                onDidChangeViewState(callback) { this.onViewState = callback; },
                dispose() {},
            };
            return panel;
        },
    },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
};
let extension;
try { extension = require('../out/extension'); } finally { Module._load = originalLoad; }
extension.activate({ extensionUri: {}, subscriptions: [] });

async function withPanel(t, files, callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sync-test-'));
    t.after(() => { panel.onDispose(); fs.rmSync(root, { recursive: true, force: true }); });
    warningChoice = undefined;
    warnings = [];
    configUpdates = [];
    workspaceFolder = path.join(root, 'workspace');
    fs.mkdirSync(workspaceFolder);
    ruleFiles = Object.keys(files);
    for (const [name, content] of Object.entries(files)) {
        if (content === null) continue;
        fs.mkdirSync(path.dirname(path.join(workspaceFolder, name)), { recursive: true });
        fs.writeFileSync(path.join(workspaceFolder, name), content);
    }
    commands.get('agentRulesSync.openRulesEditor')();
    await callback(panel);
}

test('reports each configured file once when the first file is missing', async (t) => {
    await withPanel(t, { 'missing.md': null, 'second.md': 'second', 'third.md': 'third' }, async (panel) => {
        await panel.receive({ command: 'load' });
        const result = panel.messages.at(-1);
        assert.equal(result.content, 'second');
        assert.equal(result.source, 'second.md');
        assert.deepEqual(result.files.map((file) => [file.file, file.state, file.inSync]), [
            ['missing.md', 'missing', undefined], ['second.md', 'present', true], ['third.md', 'present', false],
        ]);
    });
});

test('an empty first file still has priority over later files', async (t) => {
    await withPanel(t, { 'first.md': '', 'second.md': 'second' }, async (panel) => {
        await panel.receive({ command: 'load' });
        assert.equal(panel.messages.at(-1).content, '');
        assert.equal(panel.messages.at(-1).files.length, 2);
    });
});

test('a failed save without a workspace still sends a result to enable the button', async (t) => {
    await withPanel(t, { 'first.md': '' }, async (panel) => {
        workspaceFolder = undefined;
        await panel.receive({ command: 'save', content: 'new content' });
        const result = panel.messages.at(-1);
        assert.equal(result.command, 'saveResults');
        assert.equal(result.results[0].success, false);
    });
});

function runWebview(panel) {
    const elements = new Map();
    const element = () => ({
        children: [], style: {}, events: new Map(),
        addEventListener(name, callback) { this.events.set(name, callback); },
        appendChild(child) { this.children.push(child); },
        replaceChildren() { this.children = []; },
    });
    let receive;
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ postMessage() {} }),
        document: {
            getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
            createElement: element,
        },
        window: { addEventListener(name, callback) { if (name === 'message') receive = callback; } },
        setTimeout() {},
        clearTimeout() {},
    });
    vm.runInContext(panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], context);
    return { context, elements, receive(message) { receive({ data: message }); } };
}

test('renders file names as text rather than HTML', async (t) => {
    await withPanel(t, {}, async (panel) => {
        const { context, elements } = runWebview(panel);
        vm.runInContext('updateFileList([{file: "<img src=x onerror=alert(1)>", state: "missing"}])', context);
        assert.equal(elements.get('fileList').children[0].textContent, '✗ <img src=x onerror=alert(1)> (missing)');
    });
});

for (const escape of ['../outside.md', 'absolute', 'symlink']) {
    test(`rejects ${escape} for loading and saving`, async (t) => {
        await withPanel(t, { 'safe.md': 'safe' }, async (panel) => {
            const outside = path.join(path.dirname(workspaceFolder), 'outside.md');
            fs.writeFileSync(outside, 'outside original');
            let file = escape;
            if (escape === 'absolute') file = outside;
            if (escape === 'symlink') {
                file = 'link.md';
                fs.symlinkSync(outside, path.join(workspaceFolder, file));
            }
            ruleFiles = [file, 'safe.md'];
            await panel.receive({ command: 'load' });
            assert.equal(panel.messages.at(-1).content, 'safe');
            assert.equal(panel.messages.at(-1).files[0].state, 'error');
            assert.match(panel.messages.at(-1).files[0].error, /workspace/);
            await panel.receive({ command: 'save', content: 'new' });
            const saved = panel.messages.find((message) => message.command === 'saveResults');
            assert.equal(saved.results[0].success, false);
            assert.equal(fs.readFileSync(outside, 'utf8'), 'outside original');
            assert.equal(fs.readFileSync(path.join(workspaceFolder, 'safe.md'), 'utf8'), 'new');
        });
    });
}

test('allows new rule files under nested workspace directories', async (t) => {
    await withPanel(t, {}, async (panel) => {
        ruleFiles = ['.github/rules.md'];
        await panel.receive({ command: 'save', content: 'rules' });
        assert.equal(panel.messages.at(-2).results[0].success, true);
        assert.equal(fs.readFileSync(path.join(workspaceFolder, '.github/rules.md'), 'utf8'), 'rules');
    });
});

test('no workspace with an empty config reports a failure', async (t) => {
    await withPanel(t, {}, async (panel) => {
        workspaceFolder = undefined;
        await panel.receive({ command: 'save', content: 'rules' });
        assert.equal(panel.messages.at(-1).error, 'No workspace folder found');
    });
});

test('rejects a new file beneath a symlinked parent outside the workspace', async (t) => {
    await withPanel(t, {}, async (panel) => {
        const outside = path.join(path.dirname(workspaceFolder), 'outside-directory');
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(workspaceFolder, '.cursor'), 'junction');
        ruleFiles = ['.cursor/new-rules.md'];
        await panel.receive({ command: 'load' });
        assert.equal(panel.messages.at(-1).files[0].state, 'error');
        await panel.receive({ command: 'save', content: 'rules' });
        assert.equal(panel.messages.at(-2).results[0].success, false);
        assert.equal(fs.existsSync(path.join(outside, 'new-rules.md')), false);
    });
});

test('empty configuration in a workspace is an error and re-enables saving', async (t) => {
    await withPanel(t, {}, async (panel) => {
        await panel.receive({ command: 'save', content: 'rules' });
        const result = panel.messages.at(-1);
        assert.equal(result.error, 'No rule files configured');
        const webview = runWebview(panel);
        webview.elements.get('saveBtn').disabled = true;
        webview.receive(result);
        assert.equal(webview.elements.get('saveBtn').disabled, false);
        assert.equal(webview.elements.get('status').textContent, result.error);
        assert.equal(webview.elements.get('status').className, 'status error');
    });
});

test('webview locks down scripts, styles and local resources', async (t) => {
    await withPanel(t, {}, async (panel) => {
        const csp = panel.webview.html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
        const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
        assert.match(csp, /default-src 'none'/);
        assert.ok(panel.webview.html.includes(`<script nonce="${nonce}">`));
        assert.ok(panel.webview.html.includes(`<style nonce="${nonce}">`));
        assert.deepEqual(panel.options.localResourceRoots, []);
        assert.equal(panel.options.retainContextWhenHidden, true);
    });
});

test('keeps each file frontmatter out of the shared body and preserves it on save', async (t) => {
    const mdc = '---\nalwaysApply: true\n---\nold rules';
    await withPanel(t, { '.cursor/rules/project.mdc': mdc, 'AGENTS.md': 'old rules' }, async (panel) => {
        await panel.receive({ command: 'load' });
        assert.equal(panel.messages.at(-1).content, 'old rules');
        assert.deepEqual(panel.messages.at(-1).files.map((file) => file.inSync), [true, true]);
        await panel.receive({ command: 'save', content: 'new rules' });
        assert.deepEqual(warnings, []);
        assert.equal(fs.readFileSync(path.join(workspaceFolder, '.cursor/rules/project.mdc'), 'utf8'),
            '---\nalwaysApply: true\n---\nnew rules');
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'utf8'), 'new rules');
    });
});

test('asks before overwriting files whose content differs from the loaded rules', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'shared', 'CLAUDE.md': 'claude only' }, async (panel) => {
        await panel.receive({ command: 'load' });
        await panel.receive({ command: 'save', content: 'edited' });
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /CLAUDE\.md/);
        assert.doesNotMatch(warnings[0], /AGENTS\.md/);
        assert.equal(panel.messages.at(-2).error, 'Save cancelled');
        assert.deepEqual(panel.messages.at(-1).files.map((file) => file.inSync), [true, false]);
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'CLAUDE.md'), 'utf8'), 'claude only');
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'utf8'), 'shared');

        warningChoice = 'Overwrite';
        await panel.receive({ command: 'save', content: 'edited' });
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'CLAUDE.md'), 'utf8'), 'edited');
    });
});

test('asks before overwriting a file edited on disk after loading', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'shared' }, async (panel) => {
        await panel.receive({ command: 'load' });
        fs.writeFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'edited elsewhere');
        await panel.receive({ command: 'save', content: 'edited here' });
        assert.equal(warnings.length, 1);
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'utf8'), 'edited elsewhere');
    });
});

test('refreshes file statuses after saving and when the rule list changes', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'rules', 'missing.md': null }, async (panel) => {
        await panel.receive({ command: 'load' });
        await panel.receive({ command: 'save', content: 'rules' });
        const statuses = panel.messages.at(-1);
        assert.equal(statuses.command, 'fileStatuses');
        assert.deepEqual(statuses.files.map((file) => [file.state, file.inSync]), [['present', true], ['present', true]]);

        ruleFiles = ['AGENTS.md'];
        await configListener({ affectsConfiguration: (key) => key === 'agentRulesSync.ruleFiles' });
        assert.equal(panel.messages.at(-1).files.length, 1);
    });
});

test('reports unreadable rule paths as errors instead of missing files', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'rules' }, async (panel) => {
        fs.mkdirSync(path.join(workspaceFolder, 'directory.md'));
        ruleFiles = ['directory.md', 'AGENTS.md'];
        await panel.receive({ command: 'load' });
        const [directory] = panel.messages.at(-1).files;
        assert.equal(directory.state, 'error');
        assert.match(directory.error, /EISDIR/);
    });
});

test('rejects malformed save requests and re-enables saving', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'rules' }, async (panel) => {
        await panel.receive({ command: 'save', content: { toString: 'not text' } });
        assert.match(panel.messages.at(-1).error, /Invalid save request/);
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'utf8'), 'rules');
    });
});

test('validates and trims new rule file paths before adding them', async (t) => {
    await withPanel(t, {}, async () => {
        ruleFiles = ['AGENTS.md'];
        let validate;
        inputBox = (options) => { validate = options.validateInput; return '  CLAUDE.md  '; };
        await commands.get('agentRulesSync.addRuleFile')();
        assert.deepEqual(configUpdates, [{ key: 'ruleFiles', value: ['AGENTS.md', 'CLAUDE.md'], target: 2 }]);
        assert.deepEqual(ruleFiles, ['AGENTS.md']);
        assert.equal(await validate('.github/copilot-instructions.md'), undefined);
        assert.match(await validate('../outside.md'), /inside the workspace/);
        assert.match(await validate('/etc/passwd'), /relative path/);
    });
});

test('adding or removing rule files without a workspace explains the problem', async (t) => {
    await withPanel(t, {}, async () => {
        workspaceFolder = undefined;
        inputBox = () => assert.fail('should not prompt without a workspace');
        await commands.get('agentRulesSync.addRuleFile')();
        await commands.get('agentRulesSync.removeRuleFile')();
        assert.deepEqual(configUpdates, []);
    });
});

test('refreshes file statuses when the panel becomes visible again', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'rules' }, async (panel) => {
        await panel.receive({ command: 'load' });
        fs.writeFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'edited elsewhere');
        await panel.onViewState({ webviewPanel: { visible: true } });
        assert.equal(panel.messages.at(-1).command, 'fileStatuses');
        assert.equal(panel.messages.at(-1).files[0].inSync, false);
    });
});

test('re-validates paths after confirmation so a symlink swapped in meanwhile is not followed', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'shared', 'CLAUDE.md': 'claude only' }, async (panel) => {
        const outside = path.join(path.dirname(workspaceFolder), 'outside.md');
        fs.writeFileSync(outside, 'outside original');
        await panel.receive({ command: 'load' });
        warningChoice = () => {
            fs.rmSync(path.join(workspaceFolder, 'AGENTS.md'));
            fs.symlinkSync(outside, path.join(workspaceFolder, 'AGENTS.md'));
            return 'Overwrite';
        };
        await panel.receive({ command: 'save', content: 'edited' });
        assert.equal(fs.readFileSync(outside, 'utf8'), 'outside original');
        const saved = panel.messages.find((message) => message.command === 'saveResults');
        assert.deepEqual(saved.results.map((result) => [result.file, result.success]), [['AGENTS.md', false], ['CLAUDE.md', true]]);
    });
});

test('asks again for files that start to differ while the confirmation is open', async (t) => {
    await withPanel(t, { 'AGENTS.md': 'shared', 'CLAUDE.md': 'claude only' }, async (panel) => {
        await panel.receive({ command: 'load' });
        const choices = [
            () => { fs.writeFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'edited meanwhile'); return 'Overwrite'; },
            () => undefined,
        ];
        warningChoice = () => choices.shift()();
        await panel.receive({ command: 'save', content: 'edited' });
        assert.equal(warnings.length, 2);
        assert.match(warnings[1], /AGENTS\.md/);
        assert.doesNotMatch(warnings[1], /CLAUDE\.md/);
        assert.equal(panel.messages.at(-2).error, 'Save cancelled');
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'utf8'), 'edited meanwhile');
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'CLAUDE.md'), 'utf8'), 'claude only');
    });
});

test('keeps a newline after frontmatter that ended the file', async (t) => {
    await withPanel(t, { 'rules.mdc': '---\nalwaysApply: true\n---' }, async (panel) => {
        await panel.receive({ command: 'load' });
        assert.equal(panel.messages.at(-1).content, '');
        await panel.receive({ command: 'save', content: 'new rules' });
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'rules.mdc'), 'utf8'), '---\nalwaysApply: true\n---\nnew rules');
    });
});

test('keeps a byte order mark and its frontmatter with their own file', async (t) => {
    await withPanel(t, { 'rules.mdc': '\uFEFF---\nalwaysApply: true\n---\nshared', 'AGENTS.md': 'shared' }, async (panel) => {
        await panel.receive({ command: 'load' });
        assert.equal(panel.messages.at(-1).content, 'shared');
        await panel.receive({ command: 'save', content: 'new rules' });
        assert.deepEqual(warnings, []);
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'rules.mdc'), 'utf8'), '\uFEFF---\nalwaysApply: true\n---\nnew rules');
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'AGENTS.md'), 'utf8'), 'new rules');
    });
});

// Run this harness against either revision; measurement mode reports counts without
// applying the fixed-version expectations, so before/after use identical fixtures.
for (const ruleCount of [6, 256]) {
    test(`runtime waste audit: real sync with ${ruleCount} rule files in a large workspace`, async (t) => {
        const body = 'shared rules\n'.repeat(2048);
        const rules = Object.fromEntries(Array.from({ length: ruleCount }, (_, i) => [`rules/${i}.md`, body]));
        await withPanel(t, rules, async (panel) => {
            // Large unrelated tree must not contribute work to a sync.
            for (let i = 0; i < 4096; i++) {
                fs.writeFileSync(path.join(workspaceFolder, `source-${i}.txt`), 'unrelated');
            }
            const counts = {};
            counts.activation = await measureIO(t, () => extension.activate({ subscriptions: [] }));
            counts.load = await measureIO(t, () => panel.receive({ command: 'load' }));
            counts.unchangedSave = await measureIO(t, () => panel.receive({ command: 'save', content: body }));
            counts.changedSave = await measureIO(t, () => panel.receive({ command: 'save', content: body + 'edit\n' }));
            counts.repeatSave = await measureIO(t, () => panel.receive({ command: 'save', content: body + 'edit\n' }));
            if (process.env.AUDIT_MEASURE === '1') {
                console.log(JSON.stringify({ ruleFiles: ruleCount, unrelatedFiles: 4096, bodyBytes: Buffer.byteLength(body), counts }));
            } else {
                assert.ok(Object.values(counts.activation).every(count => count === 0));
                assert.equal(counts.load.reads, ruleCount);
                assert.equal(counts.unchangedSave.reads, 2 * ruleCount);
                assert.equal(counts.unchangedSave.writes, 0);
                assert.equal(counts.unchangedSave.mkdir, 0);
                assert.equal(counts.repeatSave.writes, 0);
                assert.equal(counts.changedSave.writes, ruleCount);
                for (const count of Object.values(counts)) {
                    assert.equal(count.scans, 0);
                    assert.equal(count.network, 0);
                    assert.equal(count.fsync, 0);
                    assert.equal(count.sync, 0);
                    assert.ok(count.maxPending <= 8);
                }
            }
        });
    });
}

test('writes only changed or missing files and preserves byte-identical frontmatter and mtimes', async (t) => {
    const unchanged = '\uFEFF---\r\nalwaysApply: true\r\n---\r\ndesired';
    await withPanel(t, { 'rules.mdc': unchanged, 'old.md': 'old', 'new/rules.md': null }, async (panel) => {
        const target = path.join(workspaceFolder, 'rules.mdc');
        fs.utimesSync(target, new Date(1000000), new Date(1000000));
        const before = fs.statSync(target).mtimeMs;
        await panel.receive({ command: 'load' });
        warningChoice = 'Overwrite';
        const counts = await measureIO(t, () => panel.receive({ command: 'save', content: 'desired' }));
        assert.equal(counts.writes, 2);
        assert.equal(counts.mkdir, 1);
        assert.equal(fs.statSync(target).mtimeMs, before);
        assert.equal(fs.readFileSync(target, 'utf8'), unchanged);
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'old.md'), 'utf8'), 'desired');
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'new/rules.md'), 'utf8'), 'desired');
        assert.ok(panel.messages.find(message => message.command === 'saveResults').results.every(result => result.success));
    });
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('runtime waste audit: overlapping saves do not duplicate sync work', async (t) => {
    const rules = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`rules/${i}.md`, 'shared']));
    await withPanel(t, rules, async (panel) => {
        await panel.receive({ command: 'load' });
        fs.writeFileSync(path.join(workspaceFolder, 'rules/0.md'), 'external edit');
        const entered = deferred();
        const choice = deferred();
        warningChoice = () => { entered.resolve(); return choice.promise; };
        const counts = await measureIO(t, async () => {
            const first = panel.receive({ command: 'save', content: 'edited' });
            await entered.promise;
            const second = panel.receive({ command: 'save', content: 'edited' });
            // Let both requests reach the host while the first confirmation is held.
            await new Promise(setImmediate);
            choice.resolve('Overwrite');
            await Promise.all([first, second]);
        });
        const confirmations = warnings.filter(message => message.startsWith('These rule files')).length;
        if (process.env.AUDIT_MEASURE === '1') {
            console.log(JSON.stringify({ overlappingSaves: 2, ruleFiles: 256, confirmations, counts }));
        } else {
            assert.equal(counts.writes, 256);
            assert.equal(confirmations, 1);
            assert.ok(warnings.some(message => message.includes('busy')));
            assert.equal(panel.messages.filter(message => message.command === 'saveResults').length, 1);
        }
    });
});

test('coalesces a burst of refreshes during a load into one following read pass', async (t) => {
    const rules = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`rules/${i}.md`, 'shared']));
    await withPanel(t, rules, async (panel) => {
        const entered = deferred();
        const release = deferred();
        const readFile = fs.promises.readFile;
        let held = false;
        const mock = t.mock.method(fs.promises, 'readFile', async function (...args) {
            if (!held) {
                held = true;
                entered.resolve();
                await release.promise;
            }
            return readFile.apply(this, args);
        });
        try {
            const counts = await measureIO(t, async () => {
                const load = panel.receive({ command: 'load' });
                await entered.promise;
                for (let i = 0; i < 100; i++) {
                    await panel.onViewState({ webviewPanel: { visible: true } });
                    await configListener({ affectsConfiguration: () => true });
                }
                release.resolve();
                await load;
            });
            assert.equal(counts.reads, 256); // One load and one coalesced refresh.
            assert.ok(counts.maxPending <= 8);
            assert.equal(panel.messages.filter(message => message.command === 'fileStatuses').length, 1);
        } finally {
            release.resolve();
            mock.mock.restore();
        }
    });
});

test('write failures report per-file errors and release the operation lock', async (t) => {
    await withPanel(t, { 'rules.md': 'shared' }, async (panel) => {
        await panel.receive({ command: 'load' });
        const mock = t.mock.method(fs.promises, 'writeFile', async () => { throw new Error('write failed'); });
        await panel.receive({ command: 'save', content: 'edited' });
        mock.mock.restore();
        const result = panel.messages.find(message => message.command === 'saveResults');
        assert.deepEqual(result.results, [{ file: 'rules.md', success: false, error: 'write failed' }]);
        await panel.receive({ command: 'save', content: 'edited again' });
        assert.equal(fs.readFileSync(path.join(workspaceFolder, 'rules.md'), 'utf8'), 'edited again');
    });
});

test('webview disables both controls through the final status refresh and recovers on errors', async (t) => {
    await withPanel(t, {}, async (panel) => {
        const webview = runWebview(panel);
        const load = webview.elements.get('loadBtn');
        const save = webview.elements.get('saveBtn');
        assert.equal(load.disabled, true);
        assert.equal(save.disabled, true);
        webview.receive({ command: 'loadContent', content: 'rules', files: [] });
        assert.equal(load.disabled, false);
        assert.equal(save.disabled, false);
        save.events.get('click')();
        assert.equal(load.disabled, true);
        assert.equal(save.disabled, true);
        webview.receive({ command: 'saveResults', results: [], busy: true });
        assert.equal(load.disabled, true);
        assert.equal(save.disabled, true);
        webview.receive({ command: 'fileStatuses', files: [] });
        assert.equal(load.disabled, false);
        assert.equal(save.disabled, false);
        load.events.get('click')();
        webview.receive({ command: 'loadError', error: 'read failed' });
        assert.equal(load.disabled, false);
        assert.equal(save.disabled, false);
        assert.equal(webview.elements.get('status').textContent, 'read failed');
    });
});

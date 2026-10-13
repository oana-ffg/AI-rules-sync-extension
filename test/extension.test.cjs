const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');

const commands = new Map();
let workspaceFolder;
let ruleFiles;
let panel;
const vscode = {
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    StatusBarAlignment: { Right: 1 },
    ViewColumn: { One: 1 },
    Uri: { joinPath() {} },
    workspace: {
        get workspaceFolders() { return workspaceFolder ? [{ uri: { fsPath: workspaceFolder } }] : undefined; },
        getConfiguration() { return { get() { return ruleFiles; } }; },
    },
    window: {
        createStatusBarItem() { return { show() {}, dispose() {} }; },
        showErrorMessage() {},
        showInformationMessage() {},
        createWebviewPanel() {
            panel = {
                messages: [],
                webview: {
                    onDidReceiveMessage(callback) { panel.receive = callback; },
                    postMessage(message) { panel.messages.push(message); },
                },
                onDidDispose(callback) { this.onDispose = callback; },
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
    workspaceFolder = path.join(root, 'workspace');
    fs.mkdirSync(workspaceFolder);
    ruleFiles = Object.keys(files);
    for (const [name, content] of Object.entries(files)) {
        if (content !== null) fs.writeFileSync(path.join(workspaceFolder, name), content);
    }
    commands.get('agentRulesSync.openRulesEditor')();
    await callback(panel);
}

test('reports each configured file once when the first file is missing', async (t) => {
    await withPanel(t, { 'missing.md': null, 'second.md': 'second', 'third.md': 'third' }, async (panel) => {
        await panel.receive({ command: 'load' });
        const result = panel.messages.at(-1);
        assert.equal(result.content, 'second');
        assert.deepEqual(result.files.map((file) => [file.file, file.exists]), [
            ['missing.md', false], ['second.md', true], ['third.md', true],
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
    const element = () => ({ children: [], style: {}, addEventListener() {}, appendChild(child) { this.children.push(child); } });
    let receive;
    const context = vm.createContext({
        acquireVsCodeApi: () => ({ postMessage() {} }),
        document: {
            getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
            createElement: element,
        },
        window: { addEventListener(name, callback) { if (name === 'message') receive = callback; } },
        setTimeout() {},
    });
    vm.runInContext(panel.webview.html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    return { context, elements, receive(message) { receive({ data: message }); } };
}

test('renders file names as text rather than HTML', async (t) => {
    await withPanel(t, {}, async (panel) => {
        const { context, elements } = runWebview(panel);
        vm.runInContext('updateFileList([{file: "<img src=x onerror=alert(1)>", exists: false}])', context);
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
            assert.equal(panel.messages.at(-1).files[0].exists, false);
            await panel.receive({ command: 'save', content: 'new' });
            assert.equal(panel.messages.at(-1).results[0].success, false);
            assert.equal(fs.readFileSync(outside, 'utf8'), 'outside original');
            assert.equal(fs.readFileSync(path.join(workspaceFolder, 'safe.md'), 'utf8'), 'new');
        });
    });
}

test('allows new rule files under nested workspace directories', async (t) => {
    await withPanel(t, {}, async (panel) => {
        ruleFiles = ['.github/rules.md'];
        await panel.receive({ command: 'save', content: 'rules' });
        assert.equal(panel.messages.at(-1).results[0].success, true);
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
        assert.equal(panel.messages.at(-1).files[0].exists, false);
        await panel.receive({ command: 'save', content: 'rules' });
        assert.equal(panel.messages.at(-1).results[0].success, false);
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

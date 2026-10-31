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
        async showWarningMessage(message) { warnings.push(message); return warningChoice; },
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
        children: [], style: {}, addEventListener() {},
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
        configListener({ affectsConfiguration: (key) => key === 'agentRulesSync.ruleFiles' });
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
        assert.equal(validate('.github/copilot-instructions.md'), undefined);
        assert.match(validate('../outside.md'), /inside the workspace/);
        assert.match(validate('/etc/passwd'), /relative path/);
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
        panel.onViewState({ webviewPanel: { visible: true } });
        assert.equal(panel.messages.at(-1).command, 'fileStatuses');
        assert.equal(panel.messages.at(-1).files[0].inSync, false);
    });
});

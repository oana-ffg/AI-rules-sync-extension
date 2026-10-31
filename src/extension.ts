import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

type FileStatus = {
    file: string;
    state: 'present' | 'missing' | 'error';
    inSync?: boolean;
    lastModified?: string;
    error?: string;
};

type RuleFile = FileStatus & { fullPath?: string; frontmatter?: string; body?: string };

type SaveResult = { file: string; success: boolean; error?: string };

// Resolve both lexical paths and symlink targets before reading or writing.
// Missing descendants are allowed only beneath a real directory in the workspace.
function ruleFilePath(workspace: string, file: string): string {
    if (!file || path.isAbsolute(file) || path.win32.isAbsolute(file)) {
        throw new Error('Rule file must be a relative path inside the workspace');
    }
    const root = fs.realpathSync(workspace);
    const target = path.resolve(root, file);
    const isInside = (candidate: string) => {
        const relative = path.relative(root, candidate);
        return relative !== '' && relative !== '..' &&
            !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    if (!isInside(target)) throw new Error('Rule file must stay inside the workspace');
    let existing = target;
    while (true) {
        try {
            fs.lstatSync(existing);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            existing = path.dirname(existing);
        }
    }
    const real = fs.realpathSync(existing);
    if (real !== root && !isInside(real)) {
        throw new Error('Rule file symlink points outside the workspace');
    }
    return target;
}

// YAML frontmatter (e.g. Cursor's `alwaysApply`) configures one tool's file, so it is
// kept per file and never copied into the shared rules body.
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
    const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text);
    return match
        ? { frontmatter: match[0], body: text.slice(match[0].length) }
        : { frontmatter: '', body: text };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function configuredRuleFiles(): string[] {
    return vscode.workspace.getConfiguration('agentRulesSync').get<string[]>('ruleFiles', []);
}

function readRuleFiles(workspace: string, files: string[]): RuleFile[] {
    return files.map((file): RuleFile => {
        let fullPath: string;
        try {
            fullPath = ruleFilePath(workspace, file);
        } catch (error) {
            return { file, state: 'error', error: errorMessage(error) };
        }
        try {
            const stats = fs.statSync(fullPath);
            const { frontmatter, body } = splitFrontmatter(fs.readFileSync(fullPath, 'utf8'));
            return { file, state: 'present', fullPath, frontmatter, body, lastModified: stats.mtime.toISOString() };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, state: 'missing', fullPath };
            return { file, state: 'error', error: errorMessage(error) };
        }
    });
}

export function activate(context: vscode.ExtensionContext) {
    const openRulesEditor = vscode.commands.registerCommand('agentRulesSync.openRulesEditor', () => {
        AgentRulesPanel.createOrShow();
    });

    // Status bar button for easy access
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(edit) Agent Rules";
    statusBarItem.tooltip = "Open Agent Rules Editor";
    statusBarItem.command = 'agentRulesSync.openRulesEditor';
    statusBarItem.show();

    const addRuleFile = vscode.commands.registerCommand('agentRulesSync.addRuleFile', async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Open a workspace folder before adding agent rule files');
            return;
        }
        const input = await vscode.window.showInputBox({
            prompt: 'Enter agent rule file path to add',
            placeHolder: 'e.g., .github/copilot-instructions.md',
            validateInput: (value) => {
                if (!value.trim()) return undefined;
                try {
                    ruleFilePath(workspaceFolder.uri.fsPath, value.trim());
                    return undefined;
                } catch (error) {
                    return errorMessage(error);
                }
            }
        });
        const filePath = input?.trim();
        if (!filePath) return;

        const currentFiles = configuredRuleFiles();
        if (currentFiles.includes(filePath)) {
            vscode.window.showWarningMessage(`${filePath} is already in agent rule files`);
            return;
        }
        await vscode.workspace.getConfiguration('agentRulesSync')
            .update('ruleFiles', [...currentFiles, filePath], vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`Added ${filePath} to agent rule files`);
    });

    const removeRuleFile = vscode.commands.registerCommand('agentRulesSync.removeRuleFile', async () => {
        if (!vscode.workspace.workspaceFolders?.length) {
            vscode.window.showErrorMessage('Open a workspace folder before removing agent rule files');
            return;
        }
        const currentFiles = configuredRuleFiles();
        if (currentFiles.length === 0) {
            vscode.window.showInformationMessage('No rule files to remove');
            return;
        }

        const fileToRemove = await vscode.window.showQuickPick(currentFiles, {
            placeHolder: 'Select agent rule file to remove'
        });
        if (!fileToRemove) return;

        await vscode.workspace.getConfiguration('agentRulesSync').update(
            'ruleFiles', currentFiles.filter(file => file !== fileToRemove), vscode.ConfigurationTarget.Workspace);
        vscode.window.showInformationMessage(`Removed ${fileToRemove} from agent rule files`);
    });

    context.subscriptions.push(statusBarItem, openRulesEditor, addRuleFile, removeRuleFile);
}

/**
 * Singleton webview panel for editing the shared agent rules.
 */
class AgentRulesPanel {
    private static currentPanel: AgentRulesPanel | undefined;
    private static readonly viewType = 'agentRulesEditor';

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    // Rules body as last loaded or saved; files that drift from it need confirmation to overwrite.
    private _baseline: string | undefined;

    public static createOrShow() {
        const column = vscode.window.activeTextEditor?.viewColumn;

        if (AgentRulesPanel.currentPanel) {
            AgentRulesPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            AgentRulesPanel.viewType,
            'Agent Rules Editor',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                // The UI is fully inline and must not read any local files.
                localResourceRoots: [],
                // Keep unsaved edits when the panel is moved to a background tab.
                retainContextWhenHidden: true
            }
        );

        AgentRulesPanel.currentPanel = new AgentRulesPanel(panel);
    }

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlForWebview();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Rule files can change on disk while the panel is in the background.
        this._panel.onDidChangeViewState(event => {
            if (event.webviewPanel.visible) this._postStatuses();
        }, null, this._disposables);

        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('agentRulesSync.ruleFiles')) this._postStatuses();
        }, null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message?.command) {
                    case 'save':
                        await this._handleSave(message.content);
                        break;
                    case 'load':
                        this._loadContent();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private _workspacePath(): string | undefined {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    private _statuses(files: RuleFile[]): FileStatus[] {
        return files.map(({ file, state, lastModified, error, body }) => ({
            file, state, lastModified, error,
            inSync: state === 'present' ? body === this._baseline : undefined
        }));
    }

    private _postStatuses() {
        const workspace = this._workspacePath();
        const files = workspace ? readRuleFiles(workspace, configuredRuleFiles()) : [];
        this._panel.webview.postMessage({ command: 'fileStatuses', files: this._statuses(files) });
    }

    private async _handleSave(content: unknown) {
        try {
            if (typeof content !== 'string') throw new Error('Invalid save request');
            await this._saveToAllFiles(content);
        } catch (error) {
            const message = `Saving agent rules failed: ${errorMessage(error)}`;
            vscode.window.showErrorMessage(message);
            this._panel.webview.postMessage({ command: 'saveResults', error: message, results: [] });
        }
    }

    /**
     * Write the shared rules body to every configured file, keeping each file's own frontmatter.
     */
    private async _saveToAllFiles(content: string) {
        const syncedFiles = configuredRuleFiles();
        const workspace = this._workspacePath();

        if (!workspace) {
            const error = 'No workspace folder found';
            vscode.window.showErrorMessage(error);
            this._panel.webview.postMessage({
                command: 'saveResults',
                error,
                results: syncedFiles.map(file => ({ file, success: false, error }))
            });
            return;
        }

        if (syncedFiles.length === 0) {
            const error = 'No rule files configured';
            vscode.window.showErrorMessage(error);
            this._panel.webview.postMessage({ command: 'saveResults', error, results: [] });
            return;
        }

        const files = readRuleFiles(workspace, syncedFiles);
        const diverged = files.filter(f => f.state === 'present' && f.body !== this._baseline && f.body !== content);
        if (diverged.length > 0) {
            const overwrite = 'Overwrite';
            const choice = await vscode.window.showWarningMessage(
                `These rule files have content that differs from the loaded rules and will be overwritten: ${diverged.map(f => f.file).join(', ')}`,
                { modal: true },
                overwrite
            );
            if (choice !== overwrite) {
                this._panel.webview.postMessage({ command: 'saveResults', error: 'Save cancelled', results: [] });
                this._postStatuses();
                return;
            }
        }

        const results: SaveResult[] = files.map(f => {
            if (!f.fullPath || f.state === 'error') return { file: f.file, success: false, error: f.error };
            try {
                // Creates missing directories such as .cursor/rules/
                fs.mkdirSync(path.dirname(f.fullPath), { recursive: true });
                fs.writeFileSync(f.fullPath, (f.frontmatter ?? '') + content, 'utf8');
                return { file: f.file, success: true };
            } catch (error) {
                return { file: f.file, success: false, error: errorMessage(error) };
            }
        });

        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success);
        if (successful > 0) this._baseline = content;

        if (failed.length === 0) {
            vscode.window.showInformationMessage(`Successfully saved to ${successful} file(s)`);
        } else {
            const failedFiles = failed.map(f => `${f.file}: ${f.error}`).join('\n');
            vscode.window.showErrorMessage(`Saved to ${successful} file(s), failed to save ${failed.length} file(s):\n${failedFiles}`);
        }

        this._panel.webview.postMessage({ command: 'saveResults', results });
        this._postStatuses();
    }

    /**
     * Load the rules body from the first existing file; it is the source of truth.
     */
    private _loadContent() {
        const workspace = this._workspacePath();
        const files = workspace ? readRuleFiles(workspace, configuredRuleFiles()) : [];
        const source = files.find(f => f.state === 'present');
        this._baseline = source?.body ?? '';

        this._panel.webview.postMessage({
            command: 'loadContent',
            content: this._baseline,
            source: source?.file,
            files: this._statuses(files)
        });
    }

    public dispose() {
        AgentRulesPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }

    private _getHtmlForWebview() {
        const nonce = crypto.randomBytes(16).toString('base64');
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Rules Editor</title>
    <style nonce="${nonce}">
        /* CSS using VS Code theme variables for consistent styling */
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 20px;
            height: 100vh;
            box-sizing: border-box;
        }

        .header {
            margin-bottom: 20px;
            padding-bottom: 15px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .title {
            font-size: 24px;
            font-weight: bold;
            margin-bottom: 10px;
        }

        .file-list {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-bottom: 15px;
        }

        .file-status {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 5px;
            color: var(--vscode-terminal-background);
        }

        .file-present { background-color: var(--vscode-terminal-ansiGreen); }
        .file-diverged { background-color: var(--vscode-terminal-ansiYellow); }
        .file-missing, .file-error { background-color: var(--vscode-terminal-ansiRed); }

        .controls {
            margin-bottom: 15px;
            display: flex;
            gap: 10px;
        }

        .button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
        }

        .button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .editor-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            min-height: 0;
        }

        .editor {
            flex: 1;
            width: 100%;
            min-height: 400px;
            box-sizing: border-box;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 12px;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            resize: vertical;
        }

        .status {
            margin-top: 10px;
            padding: 8px;
            border-radius: 4px;
            font-size: 12px;
            color: var(--vscode-terminal-background);
        }

        .status.success { background-color: var(--vscode-terminal-ansiGreen); }
        .status.error { background-color: var(--vscode-terminal-ansiRed); }
        .status.info { background-color: var(--vscode-terminal-ansiBlue); }

        .container {
            display: flex;
            flex-direction: column;
            height: 100%;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">Agent Rules Editor</div>
            <div class="file-list" id="fileList"></div>
        </div>

        <div class="controls">
            <button class="button" id="loadBtn">Load Rules</button>
            <button class="button" id="saveBtn">Save to All Rule Files</button>
        </div>

        <div class="editor-container">
            <textarea class="editor" id="editor" placeholder="Agent rules will appear here when loaded..."></textarea>
        </div>

        <div id="status" class="status" hidden></div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const editor = document.getElementById('editor');
        const loadBtn = document.getElementById('loadBtn');
        const saveBtn = document.getElementById('saveBtn');
        const statusDiv = document.getElementById('status');
        const fileListDiv = document.getElementById('fileList');
        let statusTimer;

        function showStatus(message, type = 'info') {
            statusDiv.textContent = message;
            statusDiv.className = 'status ' + type;
            statusDiv.hidden = false;
            clearTimeout(statusTimer);
            statusTimer = setTimeout(() => { statusDiv.hidden = true; }, 5000);
        }

        // File names come from settings, so they are only ever rendered as text.
        function badgeText(file) {
            switch (file.state) {
                case 'present':
                    return (file.inSync ? '✓ ' : '≠ ') + file.file +
                        (file.inSync ? '' : ' (differs)') +
                        (file.lastModified ? ' (' + new Date(file.lastModified).toLocaleString() + ')' : '');
                case 'missing':
                    return '✗ ' + file.file + ' (missing)';
                default:
                    return '⚠ ' + file.file + ': ' + file.error;
            }
        }

        function updateFileList(files) {
            fileListDiv.replaceChildren();
            files.forEach(file => {
                const badge = document.createElement('div');
                const kind = file.state === 'present' && !file.inSync ? 'diverged' : file.state;
                badge.className = 'file-status file-' + kind;
                badge.textContent = badgeText(file);
                fileListDiv.appendChild(badge);
            });
        }

        loadBtn.addEventListener('click', () => {
            loadBtn.disabled = true;
            vscode.postMessage({ command: 'load' });
        });

        saveBtn.addEventListener('click', () => {
            saveBtn.disabled = true;
            vscode.postMessage({ command: 'save', content: editor.value });
        });

        window.addEventListener('message', event => {
            const message = event.data;

            switch (message.command) {
                case 'loadContent':
                    editor.value = message.content;
                    updateFileList(message.files);
                    loadBtn.disabled = false;
                    if (message.source) {
                        showStatus('Agent rules loaded from ' + message.source, 'success');
                    } else {
                        showStatus('No existing agent rules found', 'info');
                    }
                    break;

                case 'fileStatuses':
                    updateFileList(message.files);
                    break;

                case 'saveResults': {
                    saveBtn.disabled = false;
                    if (message.error) {
                        showStatus(message.error, 'error');
                        break;
                    }
                    const successful = message.results.filter(r => r.success).length;
                    const failed = message.results.filter(r => !r.success).length;

                    if (failed === 0) {
                        showStatus('Successfully saved to ' + successful + ' file(s)', 'success');
                    } else {
                        showStatus('Saved to ' + successful + ' file(s), failed ' + failed + ' file(s)', 'error');
                    }
                    break;
                }
            }
        });

        // Automatically load content when the panel first opens
        vscode.postMessage({ command: 'load' });
    </script>
</body>
</html>`;
    }
}

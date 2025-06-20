import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    
    // Register command to open rules editor
    const openRulesEditor = vscode.commands.registerCommand('agentRulesSync.openRulesEditor', () => {
        AgentRulesPanel.createOrShow(context.extensionUri);
    });

    // Register command to add rule file
    const addRuleFile = vscode.commands.registerCommand('agentRulesSync.addRuleFile', async () => {
        const filePath = await vscode.window.showInputBox({
            prompt: 'Enter agent rule file path to add',
            placeHolder: 'e.g., .github/copilot-instructions.md'
        });

        if (filePath) {
            const config = vscode.workspace.getConfiguration('agentRulesSync');
            const currentFiles = config.get<string[]>('ruleFiles', []);
            
            if (!currentFiles.includes(filePath)) {
                currentFiles.push(filePath);
                await config.update('ruleFiles', currentFiles, vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage(`Added ${filePath} to agent rule files`);
            } else {
                vscode.window.showWarningMessage(`${filePath} is already in agent rule files`);
            }
        }
    });

    // Register command to remove rule file
    const removeRuleFile = vscode.commands.registerCommand('agentRulesSync.removeRuleFile', async () => {
        const config = vscode.workspace.getConfiguration('agentRulesSync');
        const currentFiles = config.get<string[]>('ruleFiles', []);
        
        if (currentFiles.length === 0) {
            vscode.window.showInformationMessage('No rule files to remove');
            return;
        }

        const fileToRemove = await vscode.window.showQuickPick(currentFiles, {
            placeHolder: 'Select agent rule file to remove'
        });

        if (fileToRemove) {
            const updatedFiles = currentFiles.filter(file => file !== fileToRemove);
            await config.update('ruleFiles', updatedFiles, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Removed ${fileToRemove} from agent rule files`);
        }
    });

    context.subscriptions.push(openRulesEditor, addRuleFile, removeRuleFile);
}

class AgentRulesPanel {
    public static currentPanel: AgentRulesPanel | undefined;
    public static readonly viewType = 'agentRulesEditor';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

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
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        AgentRulesPanel.currentPanel = new AgentRulesPanel(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'save':
                        await this._saveToAllFiles(message.content);
                        break;
                    case 'load':
                        await this._loadContent();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private async _saveToAllFiles(content: string) {
        const config = vscode.workspace.getConfiguration('agentRulesSync');
        const syncedFiles = config.get<string[]>('ruleFiles', []);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        const results: { file: string; success: boolean; error?: string }[] = [];

        for (const filePath of syncedFiles) {
            try {
                const fullPath = path.join(workspaceFolder.uri.fsPath, filePath);
                const dir = path.dirname(fullPath);
                
                // Create directory if it doesn't exist
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                fs.writeFileSync(fullPath, content, 'utf8');
                results.push({ file: filePath, success: true });
            } catch (error) {
                results.push({ 
                    file: filePath, 
                    success: false, 
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }

        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success);

        if (failed.length === 0) {
            vscode.window.showInformationMessage(`Successfully saved to ${successful} file(s)`);
        } else {
            const failedFiles = failed.map(f => `${f.file}: ${f.error}`).join('\n');
            vscode.window.showErrorMessage(`Saved to ${successful} file(s), failed to save ${failed.length} file(s):\n${failedFiles}`);
        }

        // Send results back to webview
        this._panel.webview.postMessage({
            command: 'saveResults',
            results: results
        });
    }

    private async _loadContent() {
        const config = vscode.workspace.getConfiguration('agentRulesSync');
        const syncedFiles = config.get<string[]>('ruleFiles', []);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            this._panel.webview.postMessage({
                command: 'loadContent',
                content: '',
                files: []
            });
            return;
        }

        let content = '';
        const fileStatuses: { file: string; exists: boolean; lastModified?: string }[] = [];

        // Try to load content from the first existing file
        for (const filePath of syncedFiles) {
            try {
                const fullPath = path.join(workspaceFolder.uri.fsPath, filePath);
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    content = fs.readFileSync(fullPath, 'utf8');
                    fileStatuses.push({
                        file: filePath,
                        exists: true,
                        lastModified: stats.mtime.toISOString()
                    });
                    break; // Use content from first existing file
                } else {
                    fileStatuses.push({
                        file: filePath,
                        exists: false
                    });
                }
            } catch (error) {
                fileStatuses.push({
                    file: filePath,
                    exists: false
                });
            }
        }

        // Check all other files for existence
        for (let i = 1; i < syncedFiles.length; i++) {
            const filePath = syncedFiles[i];
            try {
                const fullPath = path.join(workspaceFolder.uri.fsPath, filePath);
                if (fs.existsSync(fullPath)) {
                    const stats = fs.statSync(fullPath);
                    fileStatuses.push({
                        file: filePath,
                        exists: true,
                        lastModified: stats.mtime.toISOString()
                    });
                } else {
                    fileStatuses.push({
                        file: filePath,
                        exists: false
                    });
                }
            } catch (error) {
                fileStatuses.push({
                    file: filePath,
                    exists: false
                });
            }
        }

        this._panel.webview.postMessage({
            command: 'loadContent',
            content: content,
            files: fileStatuses
        });
    }

    public dispose() {
        AgentRulesPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Rules Editor</title>
    <style>
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
        }
        
                 .file-exists {
             background-color: var(--vscode-terminal-ansiGreen);
             color: var(--vscode-terminal-background);
         }
         
         .file-missing {
             background-color: var(--vscode-terminal-ansiRed);
             color: var(--vscode-terminal-background);
         }
        
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
        }
        
                 .status.success {
             background-color: var(--vscode-terminal-ansiGreen);
             color: var(--vscode-terminal-background);
         }
         
         .status.error {
             background-color: var(--vscode-terminal-ansiRed);
             color: var(--vscode-terminal-background);
         }
         
         .status.info {
             background-color: var(--vscode-terminal-ansiBlue);
             color: var(--vscode-terminal-background);
         }
        
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
            <div class="file-list" id="fileList">
                <!-- File status badges will be inserted here -->
            </div>
        </div>
        
                 <div class="controls">
             <button class="button" id="loadBtn">Load Rules</button>
             <button class="button" id="saveBtn">Save to All Rule Files</button>
         </div>
        
        <div class="editor-container">
                         <textarea class="editor" id="editor" placeholder="Agent rules will appear here when loaded..."></textarea>
        </div>
        
        <div id="status" class="status" style="display: none;"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const editor = document.getElementById('editor');
        const loadBtn = document.getElementById('loadBtn');
        const saveBtn = document.getElementById('saveBtn');
        const statusDiv = document.getElementById('status');
        const fileListDiv = document.getElementById('fileList');

        function showStatus(message, type = 'info') {
            statusDiv.textContent = message;
            statusDiv.className = 'status ' + type;
            statusDiv.style.display = 'block';
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 5000);
        }

        function updateFileList(files) {
            fileListDiv.innerHTML = '';
            files.forEach(file => {
                const badge = document.createElement('div');
                badge.className = 'file-status ' + (file.exists ? 'file-exists' : 'file-missing');
                badge.innerHTML = file.exists 
                    ? '✓ ' + file.file + (file.lastModified ? ' (' + new Date(file.lastModified).toLocaleString() + ')' : '')
                    : '✗ ' + file.file + ' (missing)';
                fileListDiv.appendChild(badge);
            });
        }

        loadBtn.addEventListener('click', () => {
            loadBtn.disabled = true;
            vscode.postMessage({ command: 'load' });
        });

        saveBtn.addEventListener('click', () => {
            const content = editor.value;
            saveBtn.disabled = true;
            vscode.postMessage({ 
                command: 'save', 
                content: content 
            });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'loadContent':
                    editor.value = message.content;
                    updateFileList(message.files);
                    loadBtn.disabled = false;
                                         if (message.content) {
                         showStatus('Agent rules loaded successfully', 'success');
                     } else {
                         showStatus('No existing agent rules found', 'info');
                     }
                    break;
                    
                case 'saveResults':
                    saveBtn.disabled = false;
                    const successful = message.results.filter(r => r.success).length;
                    const failed = message.results.filter(r => !r.success).length;
                    
                    if (failed === 0) {
                        showStatus('Successfully saved to ' + successful + ' file(s)', 'success');
                    } else {
                        showStatus('Saved to ' + successful + ' file(s), failed ' + failed + ' file(s)', 'error');
                    }
                    break;
            }
        });

        // Load content on initial load
        vscode.postMessage({ command: 'load' });
    </script>
</body>
</html>`;
    }
}

export function deactivate() {} 
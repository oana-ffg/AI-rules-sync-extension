import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Extension activation function - called when the extension is first activated
 * This happens when one of our commands is executed for the first time
 */
export function activate(context: vscode.ExtensionContext) {
    
    // Register command to open the main agent rules editor interface
    // This creates or reveals the webview panel where users edit their agent rules
    const openRulesEditor = vscode.commands.registerCommand('agentRulesSync.openRulesEditor', () => {
        AgentRulesPanel.createOrShow(context.extensionUri);
    });

    // Register command to add a new rule file to the sync list
    // This allows users to dynamically add more agent rule files to sync
    const addRuleFile = vscode.commands.registerCommand('agentRulesSync.addRuleFile', async () => {
        // Show input box for user to enter the file path
        const filePath = await vscode.window.showInputBox({
            prompt: 'Enter agent rule file path to add',
            placeHolder: 'e.g., .github/copilot-instructions.md'
        });

        if (filePath) {
            // Get current configuration for this extension
            const config = vscode.workspace.getConfiguration('agentRulesSync');
            const currentFiles = config.get<string[]>('ruleFiles', []);
            
            // Check if file is already in the list to avoid duplicates
            if (!currentFiles.includes(filePath)) {
                currentFiles.push(filePath);
                // Update the workspace configuration with the new file list
                await config.update('ruleFiles', currentFiles, vscode.ConfigurationTarget.Workspace);
                vscode.window.showInformationMessage(`Added ${filePath} to agent rule files`);
            } else {
                vscode.window.showWarningMessage(`${filePath} is already in agent rule files`);
            }
        }
    });

    // Register command to remove a rule file from the sync list
    // This allows users to stop syncing specific agent rule files
    const removeRuleFile = vscode.commands.registerCommand('agentRulesSync.removeRuleFile', async () => {
        const config = vscode.workspace.getConfiguration('agentRulesSync');
        const currentFiles = config.get<string[]>('ruleFiles', []);
        
        // Check if there are any files to remove
        if (currentFiles.length === 0) {
            vscode.window.showInformationMessage('No rule files to remove');
            return;
        }

        // Show dropdown menu with current files for user to select from
        const fileToRemove = await vscode.window.showQuickPick(currentFiles, {
            placeHolder: 'Select agent rule file to remove'
        });

        if (fileToRemove) {
            // Remove the selected file from the list and update configuration
            const updatedFiles = currentFiles.filter(file => file !== fileToRemove);
            await config.update('ruleFiles', updatedFiles, vscode.ConfigurationTarget.Workspace);
            vscode.window.showInformationMessage(`Removed ${fileToRemove} from agent rule files`);
        }
    });

    // Register all commands with VS Code so they can be disposed when extension deactivates
    context.subscriptions.push(openRulesEditor, addRuleFile, removeRuleFile);
}

/**
 * AgentRulesPanel class manages the webview panel for editing agent rules
 * This is a singleton - only one panel can be open at a time
 */
class AgentRulesPanel {
    // Static reference to the current panel instance (singleton pattern)
    public static currentPanel: AgentRulesPanel | undefined;
    // Unique identifier for this webview type
    public static readonly viewType = 'agentRulesEditor';

    // Private properties for the webview panel and extension resources
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = []; // Track disposables for cleanup

    /**
     * Static method to create or show the agent rules panel
     * Implements singleton pattern - only one panel can be open at a time
     */
    public static createOrShow(extensionUri: vscode.Uri) {
        // Try to open panel in the same column as the active editor
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If panel already exists, just bring it to the front
        if (AgentRulesPanel.currentPanel) {
            AgentRulesPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Create new webview panel with HTML/JavaScript capabilities
        const panel = vscode.window.createWebviewPanel(
            AgentRulesPanel.viewType,
            'Agent Rules Editor',
            column || vscode.ViewColumn.One,
            {
                // Enable JavaScript in the webview
                enableScripts: true,
                // Allow loading local resources (if we had any CSS/JS files)
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        // Create new panel instance
        AgentRulesPanel.currentPanel = new AgentRulesPanel(panel, extensionUri);
    }

    /**
     * Private constructor - called only by createOrShow()
     * Sets up the webview panel and message handling
     */
    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._extensionUri = extensionUri;

        // Set the initial HTML content for the webview
        this._update();

        // Listen for when the panel is disposed (closed by user)
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Listen for messages from the webview JavaScript
        // This handles communication between the HTML/JS frontend and the extension backend
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'save':
                        // User clicked "Save to All Rule Files" - save content to all configured files
                        await this._saveToAllFiles(message.content);
                        break;
                    case 'load':
                        // User clicked "Load Rules" - load content from first available file
                        await this._loadContent();
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * Save the provided content to all configured agent rule files
     * This is the core sync functionality - writes same content to multiple files
     */
    private async _saveToAllFiles(content: string) {
        // Get list of configured rule files from workspace settings
        const config = vscode.workspace.getConfiguration('agentRulesSync');
        const syncedFiles = config.get<string[]>('ruleFiles', []);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder found');
            return;
        }

        // Track results for each file save operation
        const results: { file: string; success: boolean; error?: string }[] = [];

        // Attempt to save content to each configured file
        for (const filePath of syncedFiles) {
            try {
                const fullPath = path.join(workspaceFolder.uri.fsPath, filePath);
                const dir = path.dirname(fullPath);
                
                // Create directory structure if it doesn't exist (e.g., .cursor/rules/)
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }

                // Write the content to the file
                fs.writeFileSync(fullPath, content, 'utf8');
                results.push({ file: filePath, success: true });
            } catch (error) {
                // Record any errors for user feedback
                results.push({ 
                    file: filePath, 
                    success: false, 
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }

        // Provide user feedback about save results
        const successful = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success);

        if (failed.length === 0) {
            vscode.window.showInformationMessage(`Successfully saved to ${successful} file(s)`);
        } else {
            const failedFiles = failed.map(f => `${f.file}: ${f.error}`).join('\n');
            vscode.window.showErrorMessage(`Saved to ${successful} file(s), failed to save ${failed.length} file(s):\n${failedFiles}`);
        }

        // Send results back to webview for UI updates
        this._panel.webview.postMessage({
            command: 'saveResults',
            results: results
        });
    }

    /**
     * Load content from the first available agent rule file
     * This determines the "source of truth" - first existing file in the list wins
     */
    private async _loadContent() {
        // Get configured rule files and workspace info
        const config = vscode.workspace.getConfiguration('agentRulesSync');
        const syncedFiles = config.get<string[]>('ruleFiles', []);
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
            // No workspace - send empty content to webview
            this._panel.webview.postMessage({
                command: 'loadContent',
                content: '',
                files: []
            });
            return;
        }

        let content = '';
        const fileStatuses: { file: string; exists: boolean; lastModified?: string }[] = [];

        // Priority-based loading: use content from first existing file in the list
        // This establishes the "source of truth" when files might have different content
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
                    break; // Use content from first existing file - this is our "source of truth"
                } else {
                    fileStatuses.push({
                        file: filePath,
                        exists: false
                    });
                }
            } catch (error) {
                // File exists but can't be read (permissions, etc.)
                fileStatuses.push({
                    file: filePath,
                    exists: false
                });
            }
        }

        // Check status of all remaining files (for UI display)
        // We already checked the first file above, now check the rest
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

        // Send loaded content and file statuses to webview for display
        this._panel.webview.postMessage({
            command: 'loadContent',
            content: content,
            files: fileStatuses
        });
    }

    /**
     * Clean up resources when the panel is closed
     * This prevents memory leaks and properly disposes of event listeners
     */
    public dispose() {
        // Clear the singleton reference
        AgentRulesPanel.currentPanel = undefined;

        // Dispose the webview panel
        this._panel.dispose();

        // Dispose all event listeners and other disposables
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * Update the webview content with fresh HTML
     * Called once when panel is created
     */
    private _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    /**
     * Generate the HTML content for the webview
     * This creates the entire user interface with embedded CSS and JavaScript
     */
    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Rules Editor</title>
    <style>
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
        // JavaScript for webview interaction with VS Code extension
        // acquireVsCodeApi() provides communication bridge between webview and extension
        const vscode = acquireVsCodeApi();
        const editor = document.getElementById('editor');
        const loadBtn = document.getElementById('loadBtn');
        const saveBtn = document.getElementById('saveBtn');
        const statusDiv = document.getElementById('status');
        const fileListDiv = document.getElementById('fileList');

        // Helper function to show temporary status messages
        function showStatus(message, type = 'info') {
            statusDiv.textContent = message;
            statusDiv.className = 'status ' + type;
            statusDiv.style.display = 'block';
            setTimeout(() => {
                statusDiv.style.display = 'none';
            }, 5000);
        }

        // Helper function to update the file status badges at the top
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

                // Event listeners for button clicks
        loadBtn.addEventListener('click', () => {
            loadBtn.disabled = true;
            // Send message to extension backend to load content
            vscode.postMessage({ command: 'load' });
        });

        saveBtn.addEventListener('click', () => {
            const content = editor.value;
            saveBtn.disabled = true;
            // Send message to extension backend to save content to all files
            vscode.postMessage({ 
                command: 'save', 
                content: content 
            });
        });

        // Listen for messages from the extension backend
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
                case 'loadContent':
                    // Backend sent us content and file statuses
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
                    // Backend sent us save operation results
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

        // Automatically load content when the panel first opens
        vscode.postMessage({ command: 'load' });
    </script>
</body>
</html>`;
    }
}

/**
 * Extension deactivation function - called when the extension is deactivated
 * Currently no cleanup is needed as VS Code handles disposing of our command registrations
 */
export function deactivate() {} 
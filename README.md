# Agent Rules Sync

A VS Code/Cursor extension that provides a unified editor for syncing coding agent rule files across your project.

## Features

- **Unified Agent Rules Editor**: Edit your coding agent instructions in one place and sync across all rule files
- **Custom Rule Files**: Add or remove agent rule files from the sync list dynamically  
- **File Status Tracking**: Visual indicators show which rule files exist, which differ from the loaded rules, and their last modification times
- **Overwrite Protection**: Asks before overwriting a rule file whose content differs from the loaded rules, including edits made on disk after loading
- **Per-File Frontmatter**: YAML frontmatter (such as Cursor's `alwaysApply`) stays with its own file and is never copied into the other rule files
- **Automatic Directory Creation**: Creates missing directories when saving rule files
- **Error Handling**: Clear feedback on save success/failure for each rule file, and unreadable or rejected paths are reported as errors

## Default Agent Rule Files

The extension comes pre-configured to sync these common agent rule files:
- `AGENTS.md` - General agent instructions
- `CLAUDE.md` - Claude Code rules
- `.cursor/rules/project-rules.mdc` - Cursor/VS Code project rules
- `.github/copilot-instructions.md` - GitHub Copilot instructions
- `.roo/rules/rules.md` - Roo agent rules  
- `.windsurfrules` - Windsurf agent rules

## Usage

### Opening the Agent Rules Editor

1. Open the Command Palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux)
2. Run the command: **"Agent Rules: Open Agent Rules Editor"**
3. The rules editor will open in a new panel

You can also click **Agent Rules** in the status bar, use the editor or explorer context menu, or press `Cmd+Shift+R` in a text editor on Mac.

### Using the Agent Rules Editor

- **Load Rules**: Click "Load Rules" to load existing rules from the first available rule file
- **Edit**: Make your changes to your agent instructions in the text area
- **Save**: Click "Save to All Rule Files" to sync the rules across all configured files
- **File Status**: Green badges show rule files in sync with the loaded rules, yellow badges show files with different content, and red badges show missing or unusable files

### Managing Agent Rule Files

#### Adding a Rule File
1. Open Command Palette
2. Run: **"Agent Rules: Add Agent Rule File"**
3. Enter the relative path to the rule file (e.g., `.github/copilot-instructions.md`)

#### Removing a Rule File
1. Open Command Palette  
2. Run: **"Agent Rules: Remove Agent Rule File"**
3. Select the rule file to remove from the list

### Configuration

You can also manually edit the agent rule files list in VS Code settings:

1. Open Settings (`Cmd+,` on Mac, `Ctrl+,` on Windows/Linux)
2. Search for "Agent Rules Sync"
3. Edit the "Rule Files" array

Rule file paths must be relative and stay inside the first workspace folder; symlinks that point outside it are rejected.

In [Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust), the rule file list is only read from your user settings, so an untrusted repository cannot choose which files the editor overwrites.

## Development

### Setup
1. Install dependencies: `npm install`
2. Compile TypeScript: `npm run compile`
3. Press `F5` to launch a new Extension Development Host window

### Build
- `npm run compile` - Compile TypeScript
- `npm run watch` - Watch for changes and recompile
- `npm test` - Compile and run the tests
- `npm run package` - Build the `.vsix` package

## Requirements

- VS Code version 1.74.0 or higher
- Node.js for development

## How It Works

1. **Rules Loading**: The extension reads agent rules from the first existing rule file in your list, without its frontmatter
2. **Rules Saving**: When you save, the extension writes the same rules to all configured rule files, keeping each file's existing frontmatter
3. **Directory Creation**: Missing directories are automatically created when saving rule files
4. **File Status**: The interface shows which rule files exist and when they were last modified

This is perfect for keeping your coding agent instructions synchronized across different AI tools and platforms - whether you're using Claude, Cursor, GitHub Copilot, Windsurf, or other AI coding assistants.

## See Also

Want to sync agent skills and global instructions (such as `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`) across every machine and agent? Check out [Ratatoskr Skill Sync](https://firefungames.com/projects/ratatoskr), also by FireFun Games.

## Installation

Install **Agent Rules Sync** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=FireFunGames.agent-rules-sync), or from a VSIX file:

### Install from VSIX File

1. **Download the extension:**
   - Get the latest `agent-rules-sync-x.x.x.vsix` file from the [GitHub Releases](https://github.com/oana-ffg/AI-rules-sync-extension/releases)

2. **Install in VS Code/Cursor:**
   - **Method 1 (Command Palette):**
     - Press `Cmd+Shift+P` (Mac) or `Ctrl+Shift+P` (Windows/Linux)
     - Type: `Extensions: Install from VSIX...`
     - Select the downloaded `.vsix` file
   
   - **Method 2 (Extensions Panel):**
     - Open Extensions panel (`Cmd+Shift+X` or `Ctrl+Shift+X`)
     - Click the `...` (three dots) menu in the top-right
     - Select `Install from VSIX...`
     - Choose the downloaded `.vsix` file

3. **Verify installation:**
   - Open Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`)
   - Type "Agent Rules" - you should see the extension commands available

### Alternative: Build from Source

```bash
git clone https://github.com/oana-ffg/AI-rules-sync-extension.git
cd AI-rules-sync-extension
npm install
npm run package
```

Then install the generated `.vsix` file using the steps above. 
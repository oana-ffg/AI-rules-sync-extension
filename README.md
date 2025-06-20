# Agent Rules Sync

A VS Code/Cursor extension that provides a unified editor for syncing coding agent rule files across your project.

## Features

- **Unified Agent Rules Editor**: Edit your coding agent instructions in one place and sync across all rule files
- **Custom Rule Files**: Add or remove agent rule files from the sync list dynamically  
- **File Status Tracking**: Visual indicators show which rule files exist and their last modification times
- **Automatic Directory Creation**: Creates missing directories when saving rule files
- **Error Handling**: Clear feedback on save success/failure for each rule file

## Default Agent Rule Files

The extension comes pre-configured to sync these common agent rule files:
- `AGENTS.md` - General agent instructions
- `Claude.md` - Claude-specific rules
- `.cursor/rules/project-rules.mdc` - Cursor/VS Code project rules
- `.github/copilot-instructions.md` - GitHub Copilot instructions
- `.roo/rules/rules.md` - Roo agent rules  
- `.windsurfrules` - Windsurf agent rules

## Usage

### Opening the Agent Rules Editor

1. Open the Command Palette (`Cmd+Shift+P` on Mac, `Ctrl+Shift+P` on Windows/Linux)
2. Run the command: **"Agent Rules: Open Agent Rules Editor"**
3. The rules editor will open in a new panel

### Using the Agent Rules Editor

- **Load Rules**: Click "Load Rules" to load existing rules from the first available rule file
- **Edit**: Make your changes to your agent instructions in the text area
- **Save**: Click "Save to All Rule Files" to sync the rules across all configured files
- **File Status**: Green badges show existing rule files, red badges show missing rule files

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

## Development

### Setup
1. Install dependencies: `npm install`
2. Compile TypeScript: `npm run compile`
3. Press `F5` to launch a new Extension Development Host window

### Build
- `npm run compile` - Compile TypeScript
- `npm run watch` - Watch for changes and recompile

## Requirements

- VS Code version 1.74.0 or higher
- Node.js for development

## How It Works

1. **Rules Loading**: The extension reads agent rules from the first existing rule file in your list
2. **Rules Saving**: When you save, the extension writes the same rules to all configured rule files
3. **Directory Creation**: Missing directories are automatically created when saving rule files
4. **File Status**: The interface shows which rule files exist and when they were last modified

This is perfect for keeping your coding agent instructions synchronized across different AI tools and platforms - whether you're using Claude, Cursor, GitHub Copilot, Windsurf, or other AI coding assistants.

## Installation

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
npm run compile
npx vsce package --no-dependencies
```

Then install the generated `.vsix` file using the steps above. 
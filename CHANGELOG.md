# Changelog

## 1.2.0

- **Overwrite protection:** saving asks before overwriting a rule file whose content differs from the loaded rules, including edits made on disk after loading.
- **Frontmatter stays per file:** YAML frontmatter such as Cursor's `alwaysApply` is kept with its own file instead of being wiped or copied into the other rule files.
- **Workspace trust:** in Restricted Mode, the rule file list is only read from user settings.
- **`CLAUDE.md` default:** the default list now uses `CLAUDE.md`, the name Claude Code reads. On case-sensitive file systems such as Linux, rename an existing `Claude.md` to `CLAUDE.md`; on macOS and Windows nothing changes.
- **Keybinding:** `Ctrl+Shift+R` is no longer bound on Windows and Linux, where it overrode VS Code's Refactor command. `Cmd+Shift+R` on macOS is unchanged.
- Unsaved edits survive hiding the editor tab, file badges refresh automatically and show which files differ, and unreadable or rejected paths are reported as errors.
- The extension now activates after startup instead of immediately.
- Locked down the editor webview with a Content Security Policy.

## 1.1.1

- Fixed the publisher ID in the manifest.

## 1.1.0

- Added the status bar button, keyboard shortcut and context menu entries.

## 1.0.0

- Initial release.

# Change Log

All notable changes to the "pick-changes" extension (forked from "quick-open-git-status") will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Add a default shortcut for Pick Git changes: `Cmd+G` `P` (macOS) / `Ctrl+G` `P` (Windows/Linux)
- Rename the extension to **Pick Changes** (`pick-changes`); the command is now `Pick Git changes` (`pick-changes.open`)
- Add chainable search filters: `#repo`, `@status`, `%staged` / `%unstaged` / `%merge`, and `?` for help
- Press Tab (like Enter) to pick the highlighted filter suggestion
- Show filter suggestions with match counts while typing `#`, `@` or `%`
- Keep the Suggestions and group dividers visible while typing (results stay in group order)
- Search matches the full relative path (folders too, e.g. `src/ext`), ranking file-name matches first within each group; in multi-root workspaces the repo name is searched too
- Group files like Source Control: Merge Changes, Staged Changes, Changes (partially staged files appear in both)
- Show staged counts (index vs HEAD) and unstaged counts (working tree vs index) separately
- Add an Unstage button for staged files
- Discard in Changes now restores from the index, keeping staged changes
- Restore file icon theme icons in Quick Pick (`ThemeIcon.File` + `resourceUri`)
- Show single-letter status (`M`, `A`, `D`, `R`, `U`) like the Source Control view
- Show merge conflicts as `!` instead of mislabeling them as untracked (discard no longer deletes conflicted files)
- Fix untracked line counts being one too high for files ending in a newline
- Show untracked binary files (images, etc.) as `U binary` instead of a bogus line count
- Switch package manager from Yarn 1 to pnpm
- Update toolchain: TypeScript 6.0, ESLint 10 (flat config) + typescript-eslint 8, `@vscode/test-cli` / `@vscode/test-electron`, `@vscode/vsce`
- Update `simple-git` to 4.x
- Remove redundant `activationEvents` (implied by `contributes.commands`)
- Replace the sample test with a command-registration smoke test

## [0.3.3]

- Show filename as the primary label (like Quick Open)
- Show `folder • Modified +N -M` as muted description text
- Remove file icons (host did not apply file icon theme icons in Quick Pick)
- Add hover buttons to stage or discard changes (SCM-style)

## [0.3.2]

- Use file icon theme icons via `ThemeIcon.File` + `resourceUri`
- Move status and `+` / `-` counts to the end of each row (description)

## [0.3.1]

- Always show green `+` / red `-` counts (not only on hover)
- Use plain `+` / `-` characters instead of boxed diff codicons
- Show file-type icons in the label alongside the colored counts badge

## [0.3.0]

- Show file icons from the current file icon theme
- Show colored addition/deletion counts (green `+`, red `−`)
- Require VS Code `^1.108.0`

## [0.2.0]

- Support multiple workspace folders (grouped Quick Pick by folder name)
- Show per-file addition/deletion counts in the Quick Pick

## [0.1.1]

- Update README

## [0.1.0]

- Initial release

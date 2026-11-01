# Change Log

All notable changes to the "quick-open-git-status" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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

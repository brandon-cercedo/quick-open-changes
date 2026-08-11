# quick-open-git-status

Quickly opening changes files.

## Features

The package comes which pops up a list of all the untracked and modified files in the project.
These will be the same files that you would see on the command line if you ran `git status`.

This is similar to the command of `cmd+shift+b` in Atom.

![feature](https://i.gyazo.com/2caaabfa6980757cd9888ae3946e4993.png)

In multi-root workspaces, changed files from every folder are listed in one Quick Pick, grouped by workspace folder name. Each row shows:

- The file icon from your current file icon theme
- The relative path
- Status and plain `+` / `-` counts at the end of the row (for example `M  +12 -3`)

## Commands

- `quick-open-git-status.open`

## Keymaps

No keymap by default.

## Requirements

VS Code `1.108.0` or newer (for file icons in Quick Pick via `resourceUri`).

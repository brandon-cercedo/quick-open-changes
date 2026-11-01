# quick-open-git-status

Quickly opening changes files.

## Features

The package comes which pops up a list of all the untracked and modified files in the project.
These will be the same files that you would see on the command line if you ran `git status`.

This is similar to the command of `cmd+shift+b` in Atom.

![feature](https://i.gyazo.com/2caaabfa6980757cd9888ae3946e4993.png)

Files are grouped like the Source Control view: **Merge Changes**, **Staged Changes**, and **Changes**. A partially staged file appears in both Staged Changes and Changes, each with its own counts. In multi-root workspaces, every folder is listed in one Quick Pick, with group headers like `my-repo · Staged Changes`.

Each row shows:

- The file icon from your current file icon theme
- The **file name** as the primary label (like Quick Open)
- A muted description: `folder/path • M +12 -3` (status letter: `M` modified, `A` added, `D` deleted, `R` renamed, `C` copied, `U` untracked, `!` conflict)
- Hover buttons, depending on the group:
  - Changes: **Stage Changes** / **Discard Changes** (discard keeps staged changes)
  - Staged Changes: **Unstage Changes**
  - Merge Changes: **Stage Changes** (mark resolved) / **Discard Changes**

Discard always asks for confirmation.

## Commands

- `quick-open-git-status.open`

## Keymaps

No keymap by default.

## Requirements

VS Code `1.108.0` or newer (for file icons in Quick Pick via `resourceUri`).

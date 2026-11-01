import {
  commands,
  ExtensionContext,
  QuickInputButton,
  QuickPickItem,
  QuickPickItemKind,
  ThemeIcon,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from 'vscode';
import { simpleGit, SimpleGit, FileStatusResult } from 'simple-git';
import { promises as fs } from 'fs';
import * as path from 'path';
import { sortStringPropertyDESC } from 'typesafe-utils';

type DiffStats = {
  insertions: number;
  deletions: number;
  binary: boolean;
};

/** Same groups, in the same order, as the Source Control view. */
type ChangeGroup = 'merge' | 'staged' | 'changes';

const GROUP_ORDER: ReadonlyArray<ChangeGroup> = ['merge', 'staged', 'changes'];

const GROUP_LABELS: Record<ChangeGroup, string> = {
  merge: 'Merge Changes',
  staged: 'Staged Changes',
  changes: 'Changes',
};

/**
 * One row in the picker. A partially staged file yields two entries:
 * one in "Staged Changes" and one in "Changes".
 *
 * `status` is a single letter, matching VS Code's Source Control decorations:
 * M modified, A added, D deleted, R renamed, C copied, U untracked, ! conflict.
 */
type ChangeEntry = {
  group: ChangeGroup;
  status: string;
  relativePath: string;
  uri: Uri;
  folderName: string;
  workspacePath: string;
  stats?: DiffStats;
};

type FileQuickPickItem = QuickPickItem & {
  group: ChangeGroup;
  uri: Uri;
  status: string;
  relativePath: string;
  workspacePath: string;
};

const stageButton: QuickInputButton = {
  iconPath: new ThemeIcon('add'),
  tooltip: 'Stage Changes',
};

const unstageButton: QuickInputButton = {
  iconPath: new ThemeIcon('remove'),
  tooltip: 'Unstage Changes',
};

const discardButton: QuickInputButton = {
  iconPath: new ThemeIcon('discard'),
  tooltip: 'Discard Changes',
};

const GROUP_BUTTONS: Record<ChangeGroup, QuickInputButton[]> = {
  // Staging a conflicted file marks it as resolved, like the Source Control view.
  merge: [discardButton, stageButton],
  staged: [unstageButton],
  changes: [discardButton, stageButton],
};

/** Unmerged (conflict) XY codes from `git status --porcelain`: DD, AU, UD, UA, DU, AA, UU. */
const isConflict = (file: FileStatusResult): boolean =>
  file.index === 'U' ||
  file.working_dir === 'U' ||
  (file.index === 'A' && file.working_dir === 'A') ||
  (file.index === 'D' && file.working_dir === 'D');

const formatChangeStats = (status: string, stats?: DiffStats): string => {
  if (!stats) {
    return status;
  }
  if (stats.binary) {
    return `${status} binary`;
  }
  return `${status} +${stats.insertions} -${stats.deletions}`;
};

/** Description mirrors Quick Open: smaller/muted trailing text. */
const formatDescription = (
  relativePath: string,
  status: string,
  stats?: DiffStats
): string => {
  const folder = path.dirname(relativePath);
  const statsText = formatChangeStats(status, stats);
  if (!folder || folder === '.') {
    return statsText;
  }
  return `${folder} • ${statsText}`;
};

const countUntrackedLines = async (filePath: string): Promise<DiffStats | undefined> => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split(/\r\n|\r|\n/);
    // A trailing newline ends the last line; it doesn't start a new one.
    const insertions = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
    return { insertions, deletions: 0, binary: false };
  } catch {
    return undefined;
  }
};

/**
 * Per-file stats for `git diff <args>`. `--no-renames` keeps stats keyed by the
 * file's current path (a staged rename counts as an add of the new path).
 */
const getDiffStatsMap = async (
  git: SimpleGit,
  args: string[]
): Promise<Map<string, DiffStats>> => {
  const statsByPath = new Map<string, DiffStats>();
  try {
    const summary = await git.diffSummary(['--no-renames', ...args]);
    for (const file of summary.files) {
      if ('binary' in file && file.binary) {
        statsByPath.set(file.file, { insertions: 0, deletions: 0, binary: true });
        continue;
      }
      if ('insertions' in file && 'deletions' in file) {
        statsByPath.set(file.file, {
          insertions: file.insertions,
          deletions: file.deletions,
          binary: false,
        });
      }
    }
  } catch {
    // Ignore diff failures; rows are still listed, just without stats.
  }
  return statsByPath;
};

const gitStatusForFolder = async (
  workspaceFolder: WorkspaceFolder
): Promise<ReadonlyArray<ChangeEntry>> => {
  const workspacePath = workspaceFolder.uri.fsPath;
  const git: SimpleGit = simpleGit(workspacePath);

  let files: FileStatusResult[];
  try {
    ({ files } = await git.status());
  } catch {
    return [];
  }

  if (files.length === 0) {
    return [];
  }

  const [stagedStats, unstagedStats] = await Promise.all([
    // Index vs HEAD (vs the empty tree on a branch with no commits yet).
    getDiffStatsMap(git, ['--cached']),
    // Working tree vs index.
    getDiffStatsMap(git, []),
  ]);

  const entriesPerFile = await Promise.all(
    files.map(async (file): Promise<ChangeEntry[]> => {
      const uri = Uri.joinPath(workspaceFolder.uri, file.path);
      const base = {
        relativePath: file.path,
        uri,
        folderName: workspaceFolder.name,
        workspacePath,
      };

      if (isConflict(file)) {
        return [{ ...base, group: 'merge', status: '!' }];
      }

      const entries: ChangeEntry[] = [];
      if (file.index !== ' ' && file.index !== '?') {
        entries.push({
          ...base,
          group: 'staged',
          status: file.index,
          stats: stagedStats.get(file.path),
        });
      }
      if (file.working_dir === '?') {
        entries.push({
          ...base,
          group: 'changes',
          status: 'U',
          stats: await countUntrackedLines(uri.fsPath),
        });
      } else if (file.working_dir !== ' ') {
        entries.push({
          ...base,
          group: 'changes',
          status: file.working_dir,
          stats: unstagedStats.get(file.path),
        });
      }
      return entries;
    })
  );

  return entriesPerFile.flat();
};

const gitStatus = async (): Promise<ReadonlyArray<ChangeEntry>> => {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const results = await Promise.all(folders.map(gitStatusForFolder));
  return results.flat();
};

const toFileItem = (entry: ChangeEntry): FileQuickPickItem => ({
  // Filename only (like default Quick Open).
  label: path.basename(entry.relativePath),
  // Smaller/muted trailing text: folder • M +N -M
  description: formatDescription(entry.relativePath, entry.status, entry.stats),
  group: entry.group,
  uri: entry.uri,
  status: entry.status,
  relativePath: entry.relativePath,
  workspacePath: entry.workspacePath,
  // File icon theme icon: needs ThemeIcon.File + resourceUri together (VS Code 1.108+).
  iconPath: ThemeIcon.File,
  resourceUri: entry.uri,
  buttons: GROUP_BUTTONS[entry.group],
});

const toQuickPickItems = (
  entries: ReadonlyArray<ChangeEntry>,
  multiRoot: boolean
): Array<QuickPickItem | FileQuickPickItem> => {
  const items: Array<QuickPickItem | FileQuickPickItem> = [];
  const entriesByFolder = new Map<string, ChangeEntry[]>();

  for (const entry of entries) {
    const folderEntries = entriesByFolder.get(entry.folderName) ?? [];
    folderEntries.push(entry);
    entriesByFolder.set(entry.folderName, folderEntries);
  }

  const folderOrder =
    workspace.workspaceFolders?.map((folder) => folder.name) ??
    Array.from(entriesByFolder.keys());

  for (const folderName of folderOrder) {
    const folderEntries = entriesByFolder.get(folderName) ?? [];

    for (const group of GROUP_ORDER) {
      const groupEntries = folderEntries.filter((entry) => entry.group === group);
      if (groupEntries.length === 0) {
        continue;
      }

      // Quick Pick separators can't nest, so multi-root labels carry the folder name.
      items.push({
        label: multiRoot ? `${folderName} · ${GROUP_LABELS[group]}` : GROUP_LABELS[group],
        kind: QuickPickItemKind.Separator,
      });
      items.push(...groupEntries.map(toFileItem).sort(sortStringPropertyDESC('status')));
    }
  }

  return items;
};

const stageFile = async (item: FileQuickPickItem): Promise<void> => {
  const git = simpleGit(item.workspacePath);
  await git.add(item.relativePath);
};

const hasHead = async (git: SimpleGit): Promise<boolean> => {
  try {
    // No --quiet: simple-git only rejects when git writes to stderr.
    await git.raw(['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
};

const unstageFile = async (item: FileQuickPickItem): Promise<void> => {
  const git = simpleGit(item.workspacePath);
  if (await hasHead(git)) {
    await git.raw(['restore', '--staged', '--', item.relativePath]);
  } else {
    // No commits yet: there's no HEAD to restore from, so just drop it from the index.
    await git.raw(['rm', '--cached', '--quiet', '--', item.relativePath]);
  }
};

const discardFile = async (item: FileQuickPickItem): Promise<boolean> => {
  const confirm = await window.showWarningMessage(
    `Are you sure you want to discard changes in "${item.label}"?`,
    { modal: true },
    'Discard Changes'
  );
  if (confirm !== 'Discard Changes') {
    return false;
  }

  const git = simpleGit(item.workspacePath);

  // Untracked: remove the file from disk.
  if (item.status === 'U') {
    try {
      await fs.unlink(item.uri.fsPath);
    } catch {
      // Ignore if already gone.
    }
    return true;
  }

  if (item.group === 'merge') {
    // Conflict: reset both index and working tree to HEAD.
    await git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', item.relativePath]);
    return true;
  }

  // Unstaged changes: restore the working tree from the index, keeping staged changes.
  await git.raw(['restore', '--worktree', '--', item.relativePath]);
  return true;
};

const open = async (): Promise<void> => {
  const multiRoot = (workspace.workspaceFolders?.length ?? 0) > 1;
  const quickPick = window.createQuickPick();
  quickPick.matchOnDescription = true;
  quickPick.placeholder = 'Select a changed file';

  const refresh = async (): Promise<void> => {
    const entries = await gitStatus();
    quickPick.items = toQuickPickItems(entries, multiRoot);
  };

  await refresh();

  const selected = await new Promise<FileQuickPickItem | undefined>((resolve) => {
    let settled = false;
    const settle = (value: FileQuickPickItem | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    quickPick.onDidAccept(() => {
      const item = quickPick.selectedItems[0];
      if (!item || item.kind === QuickPickItemKind.Separator) {
        settle(undefined);
      } else {
        settle(item as FileQuickPickItem);
      }
      quickPick.hide();
    });

    quickPick.onDidTriggerItemButton(async (event) => {
      const item = event.item as FileQuickPickItem;
      try {
        if (event.button === stageButton) {
          await stageFile(item);
          await refresh();
          return;
        }
        if (event.button === unstageButton) {
          await unstageFile(item);
          await refresh();
          return;
        }
        if (event.button === discardButton) {
          const discarded = await discardFile(item);
          if (discarded) {
            await refresh();
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        window.showErrorMessage(`Git operation failed: ${message}`);
      }
    });

    quickPick.onDidHide(() => settle(undefined));
    quickPick.show();
  });

  quickPick.dispose();

  if (!selected) {
    return;
  }

  if (selected.status === 'D') {
    commands.executeCommand('workbench.scm.focus');
    return;
  }
  await window.showTextDocument(selected.uri);
};

export function activate(context: ExtensionContext) {
  const disposable = commands.registerCommand(
    'quick-open-git-status.open',
    open
  );
  context.subscriptions.push(disposable);
}

export function deactivate() {}

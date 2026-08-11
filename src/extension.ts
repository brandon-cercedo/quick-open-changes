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
import simpleGit, { SimpleGit, FileStatusResult } from 'simple-git';
import { promises as fs } from 'fs';
import * as path from 'path';
import { sortStringPropertyDESC } from 'typesafe-utils';

type DiffStats = {
  insertions: number;
  deletions: number;
  binary: boolean;
};

type FileStatusResultWithMeta = FileStatusResult & {
  uri: Uri;
  folderName: string;
  workspacePath: string;
  stats?: DiffStats;
};

type FileQuickPickItem = QuickPickItem & {
  uri: Uri;
  status: string;
  relativePath: string;
  workspacePath: string;
};

const stageButton: QuickInputButton = {
  iconPath: new ThemeIcon('add'),
  tooltip: 'Stage Changes',
};

const discardButton: QuickInputButton = {
  iconPath: new ThemeIcon('discard'),
  tooltip: 'Discard Changes',
};

const statusWord = (status: string): string => {
  switch (status) {
    case 'M':
      return 'Modified';
    case 'A':
      return 'Added';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    case 'U':
    case '?':
      return 'Untracked';
    case '!':
      return 'Ignored';
    default:
      return status;
  }
};

const formatChangeStats = (status: string, stats?: DiffStats): string => {
  const word = statusWord(status);
  if (!stats) {
    return word;
  }
  if (stats.binary) {
    return `${word}  binary`;
  }
  return `${word}  +${stats.insertions} -${stats.deletions}`;
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
    const insertions = content.length === 0 ? 0 : content.split(/\r\n|\r|\n/).length;
    return { insertions, deletions: 0, binary: false };
  } catch {
    return undefined;
  }
};

const getDiffStatsMap = async (git: SimpleGit): Promise<Map<string, DiffStats>> => {
  const statsByPath = new Map<string, DiffStats>();
  try {
    const summary = await git.diffSummary(['HEAD']);
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
    // Ignore diff failures (e.g. empty repo with no HEAD).
  }
  return statsByPath;
};

const gitStatusForFolder = async (
  workspaceFolder: WorkspaceFolder
): Promise<ReadonlyArray<FileStatusResultWithMeta>> => {
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

  const statsByPath = await getDiffStatsMap(git);

  return Promise.all(
    files.map(async (file) => {
      let stats = statsByPath.get(file.path);
      const status = file.working_dir === ' ' ? file.index : file.working_dir;
      if (!stats && status === '?') {
        stats = await countUntrackedLines(
          Uri.joinPath(workspaceFolder.uri, file.path).fsPath
        );
      }

      return {
        ...file,
        uri: Uri.joinPath(workspaceFolder.uri, file.path),
        folderName: workspaceFolder.name,
        workspacePath,
        stats,
      };
    })
  );
};

const gitStatus = async (): Promise<ReadonlyArray<FileStatusResultWithMeta>> => {
  const folders = workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const results = await Promise.all(folders.map(gitStatusForFolder));
  return results.reduce<FileStatusResultWithMeta[]>(
    (all, folderFiles) => all.concat(folderFiles),
    []
  );
};

const toQuickPickItems = (
  files: ReadonlyArray<FileStatusResultWithMeta>,
  showSeparators: boolean
): Array<QuickPickItem | FileQuickPickItem> => {
  const items: Array<QuickPickItem | FileQuickPickItem> = [];
  const filesByFolder = new Map<string, FileStatusResultWithMeta[]>();

  for (const file of files) {
    const group = filesByFolder.get(file.folderName) ?? [];
    group.push(file);
    filesByFolder.set(file.folderName, group);
  }

  const folderOrder =
    workspace.workspaceFolders?.map((folder) => folder.name) ??
    Array.from(filesByFolder.keys());

  for (const folderName of folderOrder) {
    const folderFiles = filesByFolder.get(folderName);
    if (!folderFiles || folderFiles.length === 0) {
      continue;
    }

    if (showSeparators) {
      items.push({
        label: folderName,
        kind: QuickPickItemKind.Separator,
      });
    }

    const fileItems = folderFiles
      .map((file) => {
        const status = file.working_dir === ' ' ? file.index : file.working_dir;
        const statusLabel = status === '?' ? 'U' : status;
        return {
          // Filename only (like default Quick Open).
          label: path.basename(file.path),
          // Smaller/muted trailing text: folder • Modified +N -M
          description: formatDescription(file.path, statusLabel, file.stats),
          uri: file.uri,
          status: statusLabel,
          relativePath: file.path,
          workspacePath: file.workspacePath,
          buttons: [discardButton, stageButton],
        } as FileQuickPickItem;
      })
      .sort(sortStringPropertyDESC('status'));

    items.push(...fileItems);
  }

  return items;
};

const stageFile = async (item: FileQuickPickItem): Promise<void> => {
  const git = simpleGit(item.workspacePath);
  await git.add(item.relativePath);
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
  if (item.status === 'U' || item.status === '?') {
    try {
      await fs.unlink(item.uri.fsPath);
    } catch {
      // Ignore if already gone.
    }
    return true;
  }

  // Tracked: restore index + worktree to HEAD (covers modified, deleted, staged, etc.).
  await git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', item.relativePath]);
  return true;
};

const open = async (): Promise<void> => {
  const showSeparators = (workspace.workspaceFolders?.length ?? 0) > 1;
  const quickPick = window.createQuickPick();
  quickPick.matchOnDescription = true;
  quickPick.placeholder = 'Select a changed file';

  const refresh = async (): Promise<void> => {
    const files = await gitStatus();
    quickPick.items = toQuickPickItems(files, showSeparators);
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

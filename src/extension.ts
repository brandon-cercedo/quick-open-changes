import {
  commands,
  ExtensionContext,
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
import { sortStringPropertyDESC } from 'typesafe-utils';

type DiffStats = {
  insertions: number;
  deletions: number;
  binary: boolean;
};

type FileStatusResultWithMeta = FileStatusResult & {
  uri: Uri;
  folderName: string;
  stats?: DiffStats;
};

type FileQuickPickItem = QuickPickItem & {
  uri: Uri;
  status: string;
};

const formatStatsDescription = (status: string, stats?: DiffStats): string => {
  if (!stats) {
    return status;
  }
  if (stats.binary) {
    return `${status}  binary`;
  }
  // Plain "+" / "-" characters at the end of the row (description slot).
  return `${status}  +${stats.insertions} -${stats.deletions}`;
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
  const git: SimpleGit = simpleGit(workspaceFolder.uri.fsPath);

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
          // Path only in the label.
          label: file.path,
          // Changes at the end of the row (QuickPick description is the trailing slot).
          description: formatStatsDescription(statusLabel, file.stats),
          uri: file.uri,
          status: statusLabel,
          // File-icon-theme icons: must use ThemeIcon.File + resourceUri together.
          iconPath: ThemeIcon.File,
          resourceUri: file.uri,
        } as FileQuickPickItem;
      })
      .sort(sortStringPropertyDESC('status'));

    items.push(...fileItems);
  }

  return items;
};

const open = async (): Promise<void> => {
  const files = await gitStatus();
  const showSeparators = (workspace.workspaceFolders?.length ?? 0) > 1;
  const items = toQuickPickItems(files, showSeparators);

  const selectedItem = await window.showQuickPick(items, {
    matchOnDescription: true,
    placeHolder: 'Select a changed file',
  });

  if (!selectedItem || selectedItem.kind === QuickPickItemKind.Separator) {
    return;
  }

  const fileItem = selectedItem as FileQuickPickItem;
  if (fileItem.status === 'D') {
    commands.executeCommand('workbench.scm.focus');
    return;
  }
  await window.showTextDocument(fileItem.uri);
};

export function activate(context: ExtensionContext) {
  const disposable = commands.registerCommand(
    'quick-open-git-status.open',
    open
  );
  context.subscriptions.push(disposable);
}

export function deactivate() {}

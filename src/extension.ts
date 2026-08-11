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

// Item-button alwaysVisible is supported at runtime but omitted from older typings.
type AlwaysVisibleButton = QuickInputButton & { alwaysVisible?: boolean };

const COLORS = {
  added: { dark: '#3fb950', light: '#1a7f37' },
  deleted: { dark: '#f85149', light: '#cf222e' },
  binary: { dark: '#8b949e', light: '#6e7781' },
} as const;

const svgDataUri = (svg: string): Uri =>
  Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);

const statsIcon = (
  text: string,
  darkColor: string,
  lightColor: string
): { light: Uri; dark: Uri } => {
  const width = Math.max(28, text.length * 8);
  const make = (color: string) =>
    svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16" viewBox="0 0 ${width} 16">` +
        `<text x="0" y="12" fill="${color}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12">${text}</text>` +
        `</svg>`
    );
  return { light: make(lightColor), dark: make(darkColor) };
};

const formatStatsDescription = (status: string, stats?: DiffStats): string => {
  if (!stats) {
    return status;
  }
  if (stats.binary) {
    return `${status}  binary`;
  }
  // Codicons plus plain counts (filterable). Colored duplicates also appear as item buttons.
  return `${status}  $(diff-added)${stats.insertions} $(diff-removed)${stats.deletions}`;
};

const statsButtons = (stats?: DiffStats): AlwaysVisibleButton[] | undefined => {
  if (!stats) {
    return undefined;
  }
  if (stats.binary) {
    return [
      {
        iconPath: statsIcon('binary', COLORS.binary.dark, COLORS.binary.light),
        tooltip: 'Binary file',
        alwaysVisible: true,
      },
    ];
  }

  const buttons: AlwaysVisibleButton[] = [];
  if (stats.insertions > 0 || stats.deletions === 0) {
    buttons.push({
      iconPath: statsIcon(`+${stats.insertions}`, COLORS.added.dark, COLORS.added.light),
      tooltip: `${stats.insertions} addition${stats.insertions === 1 ? '' : 's'}`,
      alwaysVisible: true,
    });
  }
  if (stats.deletions > 0) {
    buttons.push({
      iconPath: statsIcon(`−${stats.deletions}`, COLORS.deleted.dark, COLORS.deleted.light),
      tooltip: `${stats.deletions} deletion${stats.deletions === 1 ? '' : 's'}`,
      alwaysVisible: true,
    });
  }
  return buttons;
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
          label: file.path,
          description: formatStatsDescription(statusLabel, file.stats),
          uri: file.uri,
          status: statusLabel,
          iconPath: ThemeIcon.File,
          resourceUri: file.uri,
          buttons: statsButtons(file.stats),
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

  const quickPick = window.createQuickPick();
  quickPick.matchOnDescription = true;
  quickPick.placeholder = 'Select a changed file';
  quickPick.items = items;

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
    // Colored +/- buttons are display-only.
    quickPick.onDidTriggerItemButton(() => undefined);
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

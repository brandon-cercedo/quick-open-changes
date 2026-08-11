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
  stats?: DiffStats;
};

type FileQuickPickItem = QuickPickItem & {
  uri: Uri;
  status: string;
};

const COLORS = {
  added: { dark: '#3fb950', light: '#1a7f37' },
  deleted: { dark: '#f85149', light: '#cf222e' },
  binary: { dark: '#8b949e', light: '#6e7781' },
} as const;

const svgDataUri = (svg: string): Uri =>
  Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);

/**
 * Always-visible colored "+N -M" badge (plain + / - characters).
 * QuickPick description text cannot be tinted, and item buttons only show on hover,
 * so the badge is rendered as iconPath.
 */
const coloredStatsIcon = (
  stats?: DiffStats
): ThemeIcon | { light: Uri; dark: Uri } => {
  if (!stats) {
    return new ThemeIcon('file');
  }
  if (stats.binary) {
    const make = (color: string) =>
      svgDataUri(
        `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="16" viewBox="0 0 36 16">` +
          `<text x="0" y="12" fill="${color}" font-family="Segoe UI,monospace" font-size="11">bin</text>` +
          `</svg>`
      );
    return { light: make(COLORS.binary.light), dark: make(COLORS.binary.dark) };
  }

  const plus = `+${stats.insertions}`;
  const minus = `-${stats.deletions}`;
  const width = Math.max(48, (plus.length + minus.length) * 7 + 8);
  const minusX = plus.length * 7 + 4;
  const make = (added: string, deleted: string) =>
    svgDataUri(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="16" viewBox="0 0 ${width} 16">` +
        `<text x="0" y="12" fill="${added}" font-family="Segoe UI,Consolas,monospace" font-size="12">${plus}</text>` +
        `<text x="${minusX}" y="12" fill="${deleted}" font-family="Segoe UI,Consolas,monospace" font-size="12">${minus}</text>` +
        `</svg>`
    );
  return {
    light: make(COLORS.added.light, COLORS.deleted.light),
    dark: make(COLORS.added.dark, COLORS.deleted.dark),
  };
};

/** Product icons so rows still show a file-type cue while iconPath shows the +/- badge. */
const fileTypeCodicon = (filePath: string): string => {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);

  if (base === 'package.json' || base === 'package-lock.json') {
    return '$(package)';
  }
  if (base === 'tsconfig.json' || base === 'jsconfig.json') {
    return '$(json)';
  }

  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
    case '.css':
    case '.scss':
    case '.less':
    case '.html':
    case '.htm':
    case '.yml':
    case '.yaml':
      return '$(file-code)';
    case '.json':
    case '.jsonc':
      return '$(json)';
    case '.md':
    case '.mdx':
      return '$(markdown)';
    case '.svg':
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.gif':
    case '.webp':
      return '$(file-media)';
    case '.sh':
    case '.bash':
    case '.zsh':
      return '$(terminal)';
    default:
      return '$(file)';
  }
};

const formatStatsDescription = (status: string, stats?: DiffStats): string => {
  if (!stats) {
    return status;
  }
  if (stats.binary) {
    return `${status}  binary`;
  }
  // Plain "+" / "-" characters only (no boxed $(diff-*) codicons).
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
          label: `${fileTypeCodicon(file.path)} ${file.path}`,
          description: formatStatsDescription(statusLabel, file.stats),
          uri: file.uri,
          status: statusLabel,
          iconPath: coloredStatsIcon(file.stats),
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

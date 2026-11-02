import {
  commands,
  ExtensionContext,
  QuickInputButton,
  QuickPick,
  QuickPickItem,
  QuickPickItemKind,
  ThemeIcon,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from "vscode";
import { simpleGit, SimpleGit, FileStatusResult } from "simple-git";
import { promises as fs } from "fs";
import * as path from "path";
import { sortStringPropertyDESC } from "typesafe-utils";

type DiffStats = {
  insertions: number;
  deletions: number;
  binary: boolean;
};

/** Same groups, in the same order, as the Source Control view. */
type ChangeGroup = "merge" | "staged" | "changes";

const GROUP_ORDER: ReadonlyArray<ChangeGroup> = ["merge", "staged", "changes"];

const GROUP_LABELS: Record<ChangeGroup, string> = {
  merge: "Merge Changes",
  staged: "Staged Changes",
  changes: "Changes",
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
  iconPath: new ThemeIcon("add"),
  tooltip: "Stage Changes",
};

const unstageButton: QuickInputButton = {
  iconPath: new ThemeIcon("remove"),
  tooltip: "Unstage Changes",
};

const discardButton: QuickInputButton = {
  iconPath: new ThemeIcon("discard"),
  tooltip: "Discard Changes",
};

const GROUP_BUTTONS: Record<ChangeGroup, QuickInputButton[]> = {
  // Staging a conflicted file marks it as resolved, like the Source Control view.
  merge: [discardButton, stageButton],
  staged: [unstageButton],
  changes: [discardButton, stageButton],
};

/** Unmerged (conflict) XY codes from `git status --porcelain`: DD, AU, UD, UA, DU, AA, UU. */
const isConflict = (file: FileStatusResult): boolean =>
  file.index === "U" ||
  file.working_dir === "U" ||
  (file.index === "A" && file.working_dir === "A") ||
  (file.index === "D" && file.working_dir === "D");

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
  stats?: DiffStats,
): string => {
  const folder = path.dirname(relativePath);
  const statsText = formatChangeStats(status, stats);
  if (!folder || folder === ".") {
    return statsText;
  }
  return `${folder} • ${statsText}`;
};

const countUntrackedLines = async (
  filePath: string,
): Promise<DiffStats | undefined> => {
  try {
    const buffer = await fs.readFile(filePath);
    // Same heuristic as git: a NUL byte in the first 8000 bytes means binary.
    if (buffer.subarray(0, 8000).includes(0)) {
      return { insertions: 0, deletions: 0, binary: true };
    }
    const lines = buffer.toString("utf8").split(/\r\n|\r|\n/);
    // A trailing newline ends the last line; it doesn't start a new one.
    const insertions = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
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
  args: string[],
): Promise<Map<string, DiffStats>> => {
  const statsByPath = new Map<string, DiffStats>();
  try {
    const summary = await git.diffSummary(["--no-renames", ...args]);
    for (const file of summary.files) {
      if ("binary" in file && file.binary) {
        statsByPath.set(file.file, {
          insertions: 0,
          deletions: 0,
          binary: true,
        });
        continue;
      }
      if ("insertions" in file && "deletions" in file) {
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
  workspaceFolder: WorkspaceFolder,
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
    getDiffStatsMap(git, ["--cached"]),
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
        return [{ ...base, group: "merge", status: "!" }];
      }

      const entries: ChangeEntry[] = [];
      if (file.index !== " " && file.index !== "?") {
        entries.push({
          ...base,
          group: "staged",
          status: file.index,
          stats: stagedStats.get(file.path),
        });
      }
      if (file.working_dir === "?") {
        entries.push({
          ...base,
          group: "changes",
          status: "U",
          stats: await countUntrackedLines(uri.fsPath),
        });
      } else if (file.working_dir !== " ") {
        entries.push({
          ...base,
          group: "changes",
          status: file.working_dir,
          stats: unstagedStats.get(file.path),
        });
      }
      return entries;
    }),
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

const toFileItem = (
  entry: ChangeEntry,
  alwaysShow: boolean,
): FileQuickPickItem => ({
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
  // Set when the extension filters rows itself, so Quick Pick doesn't re-filter them.
  alwaysShow,
});

const toQuickPickItems = (
  entries: ReadonlyArray<ChangeEntry>,
  multiRoot: boolean,
  alwaysShow = false,
  /** When searching: best matches first within each group. */
  scoreOf?: (entry: ChangeEntry) => number,
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
      const groupEntries = folderEntries.filter(
        (entry) => entry.group === group,
      );
      if (groupEntries.length === 0) {
        continue;
      }

      // Quick Pick separators can't nest, so multi-root labels carry the folder name.
      items.push({
        label: multiRoot
          ? `${folderName} · ${GROUP_LABELS[group]}`
          : GROUP_LABELS[group],
        kind: QuickPickItemKind.Separator,
      });
      const fileItems = groupEntries
        .map((entry) => toFileItem(entry, alwaysShow))
        .sort(sortStringPropertyDESC("status"));
      if (scoreOf) {
        // Stable sort: equal scores keep the status order.
        const scores = new Map(
          groupEntries.map((entry) => [entry.uri.fsPath, scoreOf(entry)]),
        );
        fileItems.sort(
          (a, b) =>
            (scores.get(b.uri.fsPath) ?? 0) - (scores.get(a.uri.fsPath) ?? 0),
        );
      }
      items.push(...fileItems);
    }
  }

  return items;
};

// --- Search filters ------------------------------------------------------------
// Extensions can't register Quick Open prefixes (`>`, `@`, `#`, ...), so filter
// tokens are parsed from the Quick Pick input here. Tokens can go anywhere and be
// chained: different kinds combine with AND, repeats of one kind with OR.
//   #repo     workspace folder (repository) name
//   @status   m a d r c u ! (or modified, added, ..., conflict)
//   %group    staged, unstaged, merge
//   ?         list the filters

type FilterKind = "repo" | "status" | "group";

const FILTER_PREFIXES: Record<string, FilterKind> = {
  "#": "repo",
  "@": "status",
  "%": "group",
};

const STATUS_WORDS: Record<string, string> = {
  m: "modified",
  a: "added",
  d: "deleted",
  r: "renamed",
  c: "copied",
  u: "untracked",
  "!": "conflict",
};

const GROUP_KEYWORDS: Record<ChangeGroup, string[]> = {
  merge: ["merge"],
  staged: ["staged"],
  changes: ["unstaged", "changes"],
};

type SearchQuery = {
  /** True when the input contains any filter prefix, even an unfinished one. */
  hasFilters: boolean;
  filters: Record<FilterKind, string[]>;
  terms: string[];
};

const parseQuery = (value: string): SearchQuery => {
  const query: SearchQuery = {
    hasFilters: false,
    filters: { repo: [], status: [], group: [] },
    terms: [],
  };
  for (const token of value.toLowerCase().split(/\s+/).filter(Boolean)) {
    const kind = FILTER_PREFIXES[token[0]];
    if (!kind) {
      query.terms.push(token);
      continue;
    }
    query.hasFilters = true;
    // A bare prefix ("@") is still being typed: it doesn't filter yet.
    if (token.length > 1) {
      query.filters[kind].push(token.slice(1));
    }
  }
  return query;
};

const matchesStatus = (status: string, value: string): boolean => {
  const letter = status.toLowerCase();
  return value.length === 1
    ? value === letter
    : (STATUS_WORDS[letter] ?? "").startsWith(value);
};

const matchesFilter = (
  entry: ChangeEntry,
  kind: FilterKind,
  value: string,
): boolean => {
  switch (kind) {
    case "repo":
      return repoToken(entry.folderName).toLowerCase().includes(value);
    case "status":
      return matchesStatus(entry.status, value);
    case "group":
      return GROUP_KEYWORDS[entry.group].some((word) => word.startsWith(value));
  }
};

/**
 * How well `term` matches a file, like Quick Open's file search: the whole
 * relative path is searched, so folders match too (`src/ext`, `vscode/tasks`).
 * 0 means no match; higher is better.
 */
const termScore = (relativePath: string, term: string): number => {
  const filePath = relativePath.toLowerCase().replace(/\\/g, "/");
  const name = path.posix.basename(filePath);
  if (name.startsWith(term)) {
    return 4;
  }
  if (name.includes(term)) {
    return 3;
  }
  if (filePath.includes(term)) {
    return 2;
  }
  // Characters in order anywhere in the path: `srcext` -> src/extension.ts.
  let matched = 0;
  for (const ch of filePath) {
    if (ch === term[matched] && ++matched === term.length) {
      return 1;
    }
  }
  return 0;
};

/**
 * Path that plain-text search runs against. In multi-root workspaces it starts
 * with the repo (workspace folder) name, so `root1` or `root1/src` match too.
 */
const searchPathOf = (entry: ChangeEntry): string =>
  (workspace.workspaceFolders?.length ?? 0) > 1
    ? `${entry.folderName}/${entry.relativePath}`
    : entry.relativePath;

/** Match score for an entry, or -1 if a filter or search term rules it out. */
const queryScore = (entry: ChangeEntry, query: SearchQuery): number => {
  for (const kind of Object.keys(query.filters) as FilterKind[]) {
    const values = query.filters[kind];
    if (
      values.length > 0 &&
      !values.some((value) => matchesFilter(entry, kind, value))
    ) {
      return -1;
    }
  }
  let score = 0;
  const searchPath = searchPathOf(entry);
  for (const term of query.terms) {
    const termMatch = termScore(searchPath, term);
    if (termMatch === 0) {
      return -1;
    }
    score += termMatch;
  }
  return score;
};

const matchesQuery = (entry: ChangeEntry, query: SearchQuery): boolean =>
  queryScore(entry, query) >= 0;

const describeQuery = (query: SearchQuery): string | undefined => {
  const parts = [
    ...query.filters.repo.map((value) => `#${value}`),
    ...query.filters.status.map((value) => `@${value}`),
    ...query.filters.group.map((value) => `%${value}`),
  ];
  return parts.length > 0 ? `Filters: ${parts.join(" · ")}` : undefined;
};

/** Help and suggestion rows: picking one sets the input to `insertValue`. */
type InsertQuickPickItem = QuickPickItem & { insertValue: string };

const isInsertItem = (item: QuickPickItem): item is InsertQuickPickItem =>
  "insertValue" in item;

const helpItems = (): InsertQuickPickItem[] =>
  [
    {
      insertValue: "#",
      label: "#<repo>",
      description: `Filter by repository: ${filterValues("repo").join(" · ")}`,
    },
    {
      insertValue: "@",
      label: "@<status>",
      description: `Filter by status: ${Object.entries(STATUS_WORDS)
        .map(([letter, word]) => `${letter} ${word}`)
        .join(" · ")}`,
    },
    {
      insertValue: "%",
      label: "%<group>",
      description: `Filter by group: ${filterValues("group").join(" · ")}`,
    },
  ].map((item) => ({ ...item, alwaysShow: true }));

const PLACEHOLDER = "Search changes · #repo @status %group · ? help";

// --- Filter suggestions --------------------------------------------------------
// Extensions can't handle keys inside a Quick Pick, so Tab is a keybinding
// (package.json) that runs `acceptSuggestion` only while this context key is
// set, i.e. while the highlighted row is a filter suggestion. On file rows Tab
// keeps its default behavior.

const SUGGESTION_CONTEXT = "pickChanges.suggestionActive";

/** Tokens are space-separated, so repo names with spaces are matched with dashes. */
const repoToken = (folderName: string): string =>
  folderName.replace(/\s+/g, "-");

const filterValues = (kind: FilterKind): string[] => {
  switch (kind) {
    case "repo":
      return (workspace.workspaceFolders ?? []).map((folder) =>
        repoToken(folder.name),
      );
    case "status":
      return Object.values(STATUS_WORDS);
    case "group":
      return ["staged", "unstaged", "merge"];
  }
};

/** A filter token still being typed at the end of the input (no trailing space). */
type PendingFilter = {
  /** Input text before the token. */
  base: string;
  prefix: string;
  kind: FilterKind;
  partial: string;
  /** Matching values not already applied earlier in the input. */
  candidates: string[];
  /** True when values matched but all of them are already applied. */
  allApplied: boolean;
};

/** Whether an already-typed filter value `applied` covers `candidate`. */
const isApplied = (
  kind: FilterKind,
  candidate: string,
  applied: string,
): boolean => {
  const value = candidate.toLowerCase();
  switch (kind) {
    case "repo":
      return value.includes(applied);
    case "status":
      return applied.length === 1
        ? STATUS_LETTERS[candidate]?.toLowerCase() === applied
        : value.startsWith(applied);
    case "group":
      return value.startsWith(applied);
  }
};

const pendingFilter = (value: string): PendingFilter | undefined => {
  const token = /(?:^|\s)(\S+)$/.exec(value)?.[1];
  const kind = token ? FILTER_PREFIXES[token[0]] : undefined;
  if (!token || !kind) {
    return undefined;
  }
  const partial = token.slice(1).toLowerCase();
  const base = value.slice(0, value.length - token.length);
  const matched = filterValues(kind).filter(
    (candidate) =>
      candidate.toLowerCase().startsWith(partial) ||
      // Status letters complete to their word: `@!` -> `@conflict`.
      (kind === "status" && STATUS_WORDS[partial] === candidate),
  );
  // Don't offer `%unstaged` again in `%unstaged %`.
  const applied = parseQuery(base).filters[kind];
  const candidates = matched.filter(
    (candidate) => !applied.some((value) => isApplied(kind, candidate, value)),
  );
  return {
    base,
    prefix: token[0],
    kind,
    partial,
    candidates,
    allApplied: matched.length > 0 && candidates.length === 0,
  };
};

const STATUS_LETTERS: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_WORDS).map(([letter, word]) => [
    word,
    letter.toUpperCase(),
  ]),
);

/** Suggestion header and "no match" wording per filter kind. */
const KIND_LABELS: Record<FilterKind, string> = {
  repo: "Repository",
  status: "Status",
  group: "Group",
};

const fileCount = (count: number): string =>
  `${count} ${count === 1 ? "file" : "files"}`;

/**
 * Suggestions for the filter being typed, each with how many files it would
 * match given the rest of the query (e.g. `@modified   M · 8 files`).
 */
const suggestionItems = (
  value: string,
  entries: ReadonlyArray<ChangeEntry>,
): QuickPickItem[] => {
  const pending = pendingFilter(value);
  if (!pending || pending.allApplied) {
    return [];
  }
  const header: QuickPickItem = {
    label: KIND_LABELS[pending.kind],
    kind: QuickPickItemKind.Separator,
  };
  if (pending.candidates.length === 0) {
    const noMatch: InsertQuickPickItem = {
      label: `No ${pending.prefix} filter matches "${pending.partial}"`,
      description: `Enter to show all ${KIND_LABELS[pending.kind].toLowerCase()} filters`,
      insertValue: `${pending.base}${pending.prefix}`,
      alwaysShow: true,
    };
    return [header, noMatch];
  }
  const suggestions = pending.candidates.map(
    (candidate): InsertQuickPickItem => {
      const insertValue = `${pending.base}${pending.prefix}${candidate} `;
      // Count this value on its own (with the other kinds of filters), not
      // OR-ed with values of the same kind already typed.
      const query = parseQuery(insertValue);
      query.filters[pending.kind] = [candidate.toLowerCase()];
      const count = entries.filter((entry) =>
        matchesQuery(entry, query),
      ).length;
      const letter = pending.kind === "status" ? STATUS_LETTERS[candidate] : "";
      return {
        label: `${pending.prefix}${candidate}`,
        description: letter
          ? `${letter} · ${fileCount(count)}`
          : fileCount(count),
        insertValue,
        alwaysShow: true,
      };
    },
  );
  return [header, ...suggestions];
};

/** Tab handler of the picker that is currently open, if any. */
let acceptActiveSuggestion: (() => void) | undefined;

const stageFile = async (item: FileQuickPickItem): Promise<void> => {
  const git = simpleGit(item.workspacePath);
  await git.add(item.relativePath);
};

const hasHead = async (git: SimpleGit): Promise<boolean> => {
  try {
    // No --quiet: simple-git only rejects when git writes to stderr.
    await git.raw(["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
};

const unstageFile = async (item: FileQuickPickItem): Promise<void> => {
  const git = simpleGit(item.workspacePath);
  if (await hasHead(git)) {
    await git.raw(["restore", "--staged", "--", item.relativePath]);
  } else {
    // No commits yet: there's no HEAD to restore from, so just drop it from the index.
    await git.raw(["rm", "--cached", "--quiet", "--", item.relativePath]);
  }
};

const discardFile = async (item: FileQuickPickItem): Promise<boolean> => {
  const confirm = await window.showWarningMessage(
    `Are you sure you want to discard changes in "${item.label}"?`,
    { modal: true },
    "Discard Changes",
  );
  if (confirm !== "Discard Changes") {
    return false;
  }

  const git = simpleGit(item.workspacePath);

  // Untracked: remove the file from disk.
  if (item.status === "U") {
    try {
      await fs.unlink(item.uri.fsPath);
    } catch {
      // Ignore if already gone.
    }
    return true;
  }

  if (item.group === "merge") {
    // Conflict: reset both index and working tree to HEAD.
    await git.raw([
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      item.relativePath,
    ]);
    return true;
  }

  // Unstaged changes: restore the working tree from the index, keeping staged changes.
  await git.raw(["restore", "--worktree", "--", item.relativePath]);
  return true;
};

/**
 * With `sortByLabel` on (the default), a Quick Pick with any text in its input
 * drops all separators and re-sorts rows by label, so the filter suggestion and
 * group dividers vanish as soon as you type. Turning it off keeps them.
 *
 * `sortByLabel` is a proposed API (not in the stable typings), but VS Code
 * 1.108+ doesn't gate the setter. The try/catch keeps the picker working if a
 * future version starts rejecting it; the only loss would be the dividers.
 */
const keepSeparatorsWhileTyping = (quickPick: QuickPick<QuickPickItem>): void => {
  try {
    (quickPick as QuickPick<QuickPickItem> & { sortByLabel: boolean }).sortByLabel =
      false;
  } catch {
    // Proposed API rejected: dividers just hide while typing.
  }
};

const open = async (): Promise<void> => {
  const multiRoot = (workspace.workspaceFolders?.length ?? 0) > 1;
  const quickPick = window.createQuickPick();
  quickPick.matchOnDescription = true;
  quickPick.placeholder = PLACEHOLDER;
  keepSeparatorsWhileTyping(quickPick);

  let entries: ReadonlyArray<ChangeEntry> = [];

  const render = (): void => {
    if (quickPick.value.trim() === "?") {
      quickPick.title = undefined;
      quickPick.items = helpItems();
      return;
    }
    const query = parseQuery(quickPick.value);
    quickPick.title = describeQuery(query);
    if (!query.hasFilters && query.terms.length === 0) {
      quickPick.items = toQuickPickItems(entries, multiRoot);
      return;
    }
    // Quick Pick's built-in matching checks the label and description
    // separately, so `src/ext` could never match. Match the full path here and
    // mark the results `alwaysShow`; Quick Pick still highlights file-name hits.
    const scores = new Map(
      entries.map((entry) => [entry, queryScore(entry, query)]),
    );
    quickPick.items = [
      // Shown while a filter token is unfinished; they vanish after a space.
      ...suggestionItems(quickPick.value, entries),
      ...toQuickPickItems(
        entries.filter((entry) => (scores.get(entry) ?? -1) >= 0),
        multiRoot,
        true,
        (entry) => scores.get(entry) ?? 0,
      ),
    ];
  };

  const refresh = async (): Promise<void> => {
    entries = await gitStatus();
    render();
  };

  /** Help or suggestion row: put its text in the input and keep the picker open. */
  const insertSuggestion = (item: InsertQuickPickItem): void => {
    quickPick.value = item.insertValue;
    render();
  };

  // Tab picks the highlighted suggestion, same as Enter (never a file row).
  const acceptSuggestion = (): void => {
    const item = quickPick.activeItems[0];
    if (item && isInsertItem(item)) {
      insertSuggestion(item);
    }
  };

  quickPick.onDidChangeActive((items) => {
    void commands.executeCommand(
      "setContext",
      SUGGESTION_CONTEXT,
      items[0] !== undefined && isInsertItem(items[0]),
    );
  });
  quickPick.onDidChangeValue(render);
  await refresh();

  const selected = await new Promise<FileQuickPickItem | undefined>(
    (resolve) => {
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
        if (item && isInsertItem(item)) {
          insertSuggestion(item);
          return;
        }
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
          const message =
            error instanceof Error ? error.message : String(error);
          window.showErrorMessage(`Git operation failed: ${message}`);
        }
      });

      quickPick.onDidHide(() => {
        if (acceptActiveSuggestion === acceptSuggestion) {
          acceptActiveSuggestion = undefined;
          void commands.executeCommand("setContext", SUGGESTION_CONTEXT, false);
        }
        settle(undefined);
      });
      acceptActiveSuggestion = acceptSuggestion;
      quickPick.show();
    },
  );

  quickPick.dispose();

  if (!selected) {
    return;
  }

  if (selected.status === "D") {
    commands.executeCommand("workbench.scm.focus");
    return;
  }
  await window.showTextDocument(selected.uri);
};

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand("pick-changes.open", open),
    // Bound to Tab while a filter suggestion is highlighted (see package.json).
    commands.registerCommand("pick-changes.acceptSuggestion", () =>
      acceptActiveSuggestion?.(),
    ),
  );
}

// This method is called when your extension is deactivated
export function deactivate() {}

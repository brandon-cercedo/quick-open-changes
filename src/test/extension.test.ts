import * as assert from 'assert';
import * as vscode from 'vscode';

// Extension ID comes from package.json so renames don't break the tests.
const manifest = require('../../package.json') as {
  publisher: string;
  name: string;
  contributes: { commands: { command: string }[] };
};
const extensionId = `${manifest.publisher}.${manifest.name}`;

suite('Extension Test Suite', () => {
  test('registers every command in package.json', async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, 'extension should be installed in the test host');
    await extension.activate();

    const allCommands = await vscode.commands.getCommands(true);
    for (const { command } of manifest.contributes.commands) {
      assert.ok(allCommands.includes(command), `${command} should be registered`);
    }
  });

  // The picker turns off the proposed `sortByLabel` so group dividers stay
  // visible while typing. Fail loudly if VS Code starts gating it.
  test('accepts sortByLabel = false on a Quick Pick without a proposal', () => {
    const quickPick = vscode.window.createQuickPick() as vscode.QuickPick<vscode.QuickPickItem> & {
      sortByLabel: boolean;
    };
    try {
      quickPick.sortByLabel = false;
      assert.strictEqual(quickPick.sortByLabel, false);
    } finally {
      quickPick.dispose();
    }
  });

  // Pre-filled queries (e.g. `@untracked`) put the cursor at the end through
  // the proposed `valueSelection`, so typing adds to the query.
  test('accepts valueSelection on a Quick Pick without a proposal', () => {
    const quickPick = vscode.window.createQuickPick() as vscode.QuickPick<vscode.QuickPickItem> & {
      valueSelection: readonly [number, number];
    };
    try {
      quickPick.value = '@untracked ';
      quickPick.valueSelection = [11, 11];
      assert.deepStrictEqual(quickPick.valueSelection, [11, 11]);
    } finally {
      quickPick.dispose();
    }
  });

  test('formats a cursor position as path:line:column, starting at 1', () => {
    const { formatPosition } = require('../extension') as typeof import('../extension');
    assert.strictEqual(formatPosition('README.md', new vscode.Position(12, 11)), 'README.md:13:12');
  });

  test('copies the cursor position of the active editor', async () => {
    const readme = vscode.Uri.file(require.resolve('../../README.md'));
    const editor = await vscode.window.showTextDocument(readme);
    editor.selection = new vscode.Selection(12, 11, 12, 11);
    await vscode.commands.executeCommand('pick-changes.copyRelativePathWithPosition');
    // No workspace is open in the test host, so the path stays absolute.
    assert.strictEqual(await vscode.env.clipboard.readText(), `${readme.fsPath}:13:12`);
  });

  test('contributes the settings with their defaults', () => {
    const config = vscode.workspace.getConfiguration('pickChanges');
    assert.strictEqual(config.get('enterAction'), 'diff');
    assert.strictEqual(config.get('showLineCounts'), true);
    assert.strictEqual(config.get('previewWhileBrowsing'), false);
  });
});

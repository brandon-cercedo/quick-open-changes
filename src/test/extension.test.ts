import * as assert from 'assert';
import * as vscode from 'vscode';

// Extension ID comes from package.json so renames don't break the tests.
const manifest = require('../../package.json') as { publisher: string; name: string };
const extensionId = `${manifest.publisher}.${manifest.name}`;

suite('Extension Test Suite', () => {
  test('registers the pick-changes.open command', async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, 'extension should be installed in the test host');
    await extension.activate();

    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(allCommands.includes('pick-changes.open'));
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
});

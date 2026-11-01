import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  test('registers the quick-open-git-status.open command', async () => {
    const extension = vscode.extensions.getExtension('aki77.quick-open-git-status');
    assert.ok(extension, 'extension should be installed in the test host');
    await extension.activate();

    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(allCommands.includes('quick-open-git-status.open'));
  });
});

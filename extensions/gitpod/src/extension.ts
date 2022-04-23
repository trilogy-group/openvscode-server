/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Gitpod. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import Log from './common/logger';
import GitpodAuthenticationProvider from './authentication';
import LocalApp from './localApp';
import { enableSettingsSync, updateSyncContext } from './settingsSync';
import { GitpodServer } from './gitpodServer';
import TelemetryReporter from './telemetryReporter';

const EXTENSION_ID = 'gitpod.gitpod-desktop';
const FIRST_INSTALL_KEY = 'gitpod-desktop.firstInstall';
const ANALITYCS_KEY = 'bUY8IRdJ42KjLOBS9LoIHMYFBD8rSzjU';

let telemetry: TelemetryReporter;

export async function activate(context: vscode.ExtensionContext) {
	const logger = new Log('Gitpod');

	const version = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.version;
	telemetry = new TelemetryReporter(EXTENSION_ID, version, ANALITYCS_KEY);

	/* Gitpod settings sync */
	await updateSyncContext();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('gitpod.host') || e.affectsConfiguration('configurationSync.store')) {
			updateSyncContext();
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('gitpod.syncProvider.remove', async () => {
		try {
			await enableSettingsSync(false, telemetry);
		} catch (e) {
			const outputMessage = `Error setting up Settings Sync with Gitpod: ${e}`;
			vscode.window.showErrorMessage(outputMessage);
			logger.error(outputMessage);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('gitpod.syncProvider.add', async () => {
		try {
			await enableSettingsSync(true, telemetry);
		} catch (e) {
			const outputMessage = `Error setting up Settings Sync with Gitpod: ${e}`;
			vscode.window.showErrorMessage(outputMessage);
			logger.error(outputMessage);
		}
	}));

	const authProvider = new GitpodAuthenticationProvider(context, logger, telemetry);
	const localApp = new LocalApp(context, logger);
	context.subscriptions.push(authProvider);
	context.subscriptions.push(localApp);
	context.subscriptions.push(vscode.window.registerUriHandler({
		handleUri(uri: vscode.Uri) {
			// logger.trace('Handling Uri...', uri.toString());
			if (uri.path === GitpodServer.AUTH_COMPLETE_PATH) {
				authProvider.handleUri(uri);
			} else {
				localApp.handleUri(uri);
			}
		}
	}));

	if (!context.globalState.get(FIRST_INSTALL_KEY, false)) {
		context.globalState.update(FIRST_INSTALL_KEY, true);
		telemetry.sendTelemetryEvent('gitpod_desktop_installation', { kind: 'install' });
	}
}

export async function deactivate() {
	if (telemetry) {
		await telemetry.dispose();
	}
}

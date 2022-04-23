import { AutoTunnelRequest, ResolveSSHConnectionRequest, ResolveSSHConnectionResponse } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb';
import { LocalAppClient } from '@gitpod/local-app-api-grpcweb/lib/localapp_pb_service';
import { NodeHttpTransport } from '@improbable-eng/grpc-web-node-http-transport';
import { grpc } from '@improbable-eng/grpc-web';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import fetch, { Response } from 'node-fetch';
import * as tmp from 'tmp';
import * as path from 'path';
import * as vscode from 'vscode';
import Log from './common/logger';
import { Disposable } from './common/dispose';

interface SSHConnectionParams {
	workspaceId: string;
	instanceId: string;
	gitpodHost: string;
}

interface LocalAppConfig {
	gitpodHost: string;
	configFile: string;
	apiPort: number;
	pid: number;
	logPath: string;
}

interface Lock {
	pid?: number;
	value: string;
	deadline: number;
}

interface LocalAppInstallation {
	path: string;
	etag: string | null;
}

// TODO(ak) commands to show logs and stop local apps
// TODO(ak) auto stop local apps if not used for 3 hours

function throwIfCancelled(token?: vscode.CancellationToken): void {
	if (token?.isCancellationRequested) {
		throw new Error('cancelled');
	}
}

const lockPrefix = 'lock/';
const checkStaleInterval = 30000;
const installLockTimeout = 300000;
function isLock(lock: any): lock is Lock {
	return !!lock && typeof lock === 'object';
}

function checkRunning(pid: number): true | Error {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e;
	}
}

export default class LocalApp extends Disposable {

	public static AUTH_COMPLETE_PATH = '/auth-complete';
	private static lockCount = 0;

	constructor(private readonly context: vscode.ExtensionContext, private readonly logger: Log) {
		super();

		this.releaseStaleLocks();

		if (vscode.env.remoteName && context.extension.extensionKind === vscode.ExtensionKind.UI) {
			this._register(vscode.commands.registerCommand('gitpod.api.autoTunnel', this.autoTunnelCommand.bind(this)));
		}
	}

	private releaseStaleLocks(): void {
		const releaseLocks = () => {
			for (const key of this.context.globalState.keys()) {
				if (key.startsWith(lockPrefix)) {
					const lock = this.context.globalState.get(key);
					if (!isLock(lock) || Date.now() >= lock.deadline || (typeof lock.pid === 'number' && checkRunning(lock.pid) !== true)) {
						const lockName = key.slice(0, lockPrefix.length);
						this.logger.info(`cancel stale lock: ${lockName}`);
						this.context.globalState.update(key, undefined);
					}
				}
			}
		};

		releaseLocks();
		const releaseStaleLocksTimer = setInterval(releaseLocks, checkStaleInterval);
		this._register(new vscode.Disposable(() => clearInterval(releaseStaleLocksTimer)));
	}

	private async withLock<T>(lockName: string, op: (token: vscode.CancellationToken) => Promise<T>, timeout: number, token?: vscode.CancellationToken): Promise<T> {
		this.logger.info(`acquiring lock: ${lockName}`);
		const lockKey = lockPrefix + lockName;
		const value = vscode.env.sessionId + '/' + LocalApp.lockCount++;
		let currentLock: Lock | undefined;
		let deadline: number | undefined;
		const updateTimeout = 150;
		while (currentLock?.value !== value) {
			currentLock = this.context.globalState.get<Lock>(lockKey);
			if (!currentLock) {
				deadline = Date.now() + timeout + updateTimeout * 2;
				await this.context.globalState.update(lockKey, <Lock>{ value, deadline, pid: process.pid });
			}
			// TODO(ak) env.globaState.onDidChange instead, see https://github.com/microsoft/vscode/issues/131182
			await new Promise(resolve => setTimeout(resolve, updateTimeout));
			currentLock = this.context.globalState.get<Lock>(lockKey);
		}
		this.logger.info(`acquired lock: ${lockName}`);
		const tokenSource = new vscode.CancellationTokenSource();
		token?.onCancellationRequested(() => tokenSource.cancel());
		let timer = setInterval(() => {
			currentLock = this.context.globalState.get<Lock>(lockKey);
			if (currentLock?.value !== value) {
				tokenSource.cancel();
			}
		}, updateTimeout);
		try {
			const result = await op(tokenSource.token);
			return result;
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			this.logger.info(`released lock: ${lockName}`);
			await this.context.globalState.update(lockKey, undefined);
		}
	}

	private downloadLocalApp(gitpodHost: string): Promise<Response> {
		let downloadUri = vscode.Uri.parse(gitpodHost);
		let arch = '';
		if (process.arch === 'arm64') {
			arch = '-arm64';
		} if (process.arch === 'x32' && process.platform === 'win32') {
			arch = '-386';
		}
		if (process.platform === 'win32') {
			downloadUri = downloadUri.with({
				path: `/static/bin/gitpod-local-companion-windows${arch}.exe`
			});
		} else if (process.platform === 'darwin') {
			downloadUri = downloadUri.with({
				path: `/static/bin/gitpod-local-companion-darwin${arch}`
			});
		} else {
			downloadUri = downloadUri.with({
				path: `/static/bin/gitpod-local-companion-linux${arch}`
			});
		}
		this.logger.info(`fetching the local app from ${downloadUri.toString()}`);
		return fetch(downloadUri.toString());
	}

	private async installLocalApp(download: Response, token: vscode.CancellationToken): Promise<LocalAppInstallation> {
		try {
			const fileExtension = process.platform === 'win32' ? '.exe' : undefined;
			const installationPath = await new Promise<string>((resolve, reject) =>
				tmp.file({ prefix: 'gitpod-local-companion', postfix: fileExtension, keep: true, discardDescriptor: true }, (err, path) => {
					if (err) {
						return reject(err);
					}
					return resolve(path);
				})
			);
			throwIfCancelled(token);
			this.logger.info(`installing the local app to ${installationPath}`);
			const installationStream = fs.createWriteStream(installationPath);
			const cancelInstallationListener = token.onCancellationRequested(() => installationStream.destroy(new Error('cancelled')));
			await new Promise((resolve, reject) => {
				download.body.pipe(installationStream)
					.on('error', reject)
					.on('finish', resolve);
			}).finally(() => {
				cancelInstallationListener.dispose();
				installationStream.destroy();
			});

			throwIfCancelled(token);
			if (process.platform !== 'win32') {
				await fs.promises.chmod(installationPath, '755');
				throwIfCancelled(token);
			}
			const installation: LocalAppInstallation = { path: installationPath, etag: download.headers.get('etag') };
			this.logger.info(`installing the local app: ${JSON.stringify(installation, undefined, 2)}`);
			return installation;
		} catch (e) {
			this.logger.error(`failed to install the local app: ${e}`);
			throw e;
		}
	}

	private async startLocalApp(gitpodHost: string, installation: LocalAppInstallation, token: vscode.CancellationToken): Promise<LocalAppConfig> {
		try {
			const [configFile, apiPort] = await Promise.all([new Promise<string>((resolve, reject) =>
				tmp.file({ prefix: 'gitpod_ssh_config', keep: true, discardDescriptor: true }, (err, path) => {
					if (err) {
						return reject(err);
					}
					return resolve(path);
				})
			), new Promise<number>(resolve => {
				const server = http.createServer();
				server.listen(0, 'localhost', () => {
					resolve((server.address() as net.AddressInfo).port);
					server.close();
				});
			})]);
			throwIfCancelled(token);
			this.logger.info(`starting the local app with the config: ${JSON.stringify({ gitpodHost, configFile: vscode.Uri.file(configFile).toString(), apiPort }, undefined, 2)}`);

			const parsed = path.parse(installation.path);
			const logPath = path.join(parsed.dir, parsed.name) + '.log';
			const logStream = fs.createWriteStream(logPath);
			const cancelLogStreamListener = token.onCancellationRequested(() => logStream.destroy(new Error('cancelled')));
			await new Promise((resolve, reject) => {
				logStream.on('error', reject);
				logStream.on('open', resolve);
			}).finally(() => {
				cancelLogStreamListener.dispose();
			});

			const localAppProcess = cp.spawn(installation.path, {
				detached: true,
				stdio: ['ignore', logStream, logStream],
				env: {
					...process.env,
					GITPOD_HOST: gitpodHost,
					GITPOD_LCA_SSH_CONFIG: configFile,
					GITPOD_LCA_API_PORT: String(apiPort),
					GITPOD_LCA_AUTO_TUNNEL: String(false),
					GITPOD_LCA_AUTH_REDIRECT_URL: `${vscode.env.uriScheme}://${this.context.extension.id}${LocalApp.AUTH_COMPLETE_PATH}`,
					GITPOD_LCA_VERBOSE: String(vscode.workspace.getConfiguration('gitpod').get<boolean>('verbose', false)),
					GITPOD_LCA_TIMEOUT: String(vscode.workspace.getConfiguration('gitpod').get<string>('timeout', '3h'))
				}
			});
			localAppProcess.unref();
			const cancelLocalAppProcessListener = token.onCancellationRequested(() => localAppProcess.kill());
			const pid = await new Promise<number>((resolve, reject) => {
				localAppProcess.on('error', reject);
				localAppProcess.on('exit', code => reject(new Error('unexpectedly exit with code: ' + code)));
				localAppProcess.on('spawn', () => resolve(localAppProcess.pid!));
			}).finally(() => {
				cancelLocalAppProcessListener.dispose();
			});

			this.logger.info(`the local app has been stared: ${JSON.stringify({ pid, log: vscode.Uri.file(logPath).toString() }, undefined, 2)}`);
			return { gitpodHost, configFile, apiPort, pid, logPath };
		} catch (e) {
			this.logger.error(`failed to start the local app: ${e}`);
			throw e;
		}
	}

	/**
	 * Important: it should not call the local app to manage in 30sec
	 */
	private async ensureLocalApp(gitpodHost: string, configKey: string, installationKey: string, token: vscode.CancellationToken): Promise<LocalAppConfig> {
		let config = this.context.globalState.get<LocalAppConfig>(configKey);
		let installation = this.context.globalState.get<LocalAppInstallation>(installationKey);

		if (config && checkRunning(config?.pid) !== true) {
			config = undefined;
		}

		const gitpodConfig = vscode.workspace.getConfiguration('gitpod');
		const configuredInstallationPath = gitpodConfig.get<string>('installationPath');
		if (configuredInstallationPath) {
			if (installation && installation.path !== configuredInstallationPath) {
				this.logger.info(`the local app is different from configured, switching: ${JSON.stringify({ installed: installation.path, configured: configuredInstallationPath }, undefined, 2)}`);
				installation = undefined;
				if (config) {
					try {
						process.kill(config.pid);
					} catch (e) {
						this.logger.error(`failed to kill the outdated local app (pid: ${config.pid}): ${e}`);
					}
				}
				config = undefined;
			}
			if (config) {
				return config;
			}
			await fs.promises.access(configuredInstallationPath, fs.constants.X_OK);
			throwIfCancelled(token);
			installation = { path: configuredInstallationPath, etag: null };
			await this.context.globalState.update(installationKey, installation);
			throwIfCancelled(token);
		} else {
			let download: Response | Error;
			try {
				download = await this.downloadLocalApp(gitpodHost);
				throwIfCancelled(token);
				if (!download.ok) {
					download = new Error(`unexpected download response ${download.statusText} (${download.status})`);
				}
			} catch (e) {
				download = e;
			}
			if (installation) {
				const upgrade = !(download instanceof Error) && { etag: download.headers.get('etag'), url: download.url };
				if (upgrade && upgrade.etag && upgrade.etag !== installation.etag) {
					this.logger.info(`the local app is outdated, upgrading: ${JSON.stringify({ installation, upgrade }, undefined, 2)}`);
					installation = undefined;
					if (config) {
						try {
							process.kill(config.pid);
						} catch (e) {
							this.logger.error(`failed to kill the outdated local app (pid: ${config.pid}): ${e}`);
						}
					}
					config = undefined;
				}
			}
			if (config) {
				return config;
			}
			if (installation) {
				try {
					await fs.promises.access(installation.path, fs.constants.X_OK);
				} catch {
					installation = undefined;
				}
				throwIfCancelled(token);
			}
			if (!installation) {
				if (download instanceof Error) {
					throw download;
				}
				installation = await this.installLocalApp(download, token);
				await this.context.globalState.update(installationKey, installation);
				throwIfCancelled(token);
			}
		}
		config = await this.startLocalApp(gitpodHost, installation, token);
		await this.context.globalState.update(configKey, config);
		throwIfCancelled(token);
		return config;
	}

	private async withLocalApp<T>(gitpodHost: string, op: (client: LocalAppClient, config: LocalAppConfig) => Promise<T>, token?: vscode.CancellationToken): Promise<T> {
		const gitpodAuthority = vscode.Uri.parse(gitpodHost).authority;
		const configKey = 'config/' + gitpodAuthority;
		const installationKey = 'installation/' + gitpodAuthority;
		const config = await this.withLock(gitpodAuthority, token =>
			this.ensureLocalApp(gitpodHost, configKey, installationKey, token)
			, installLockTimeout, token);
		throwIfCancelled(token);
		while (true) {
			const client = new LocalAppClient('http://localhost:' + config.apiPort, { transport: NodeHttpTransport() });
			try {
				const result = await op(client, config);
				throwIfCancelled(token);
				return result;
			} catch (e) {
				throwIfCancelled(token);
				const running = checkRunning(config.pid);
				if (running === true && (e.code === grpc.Code.Unavailable || e.code === grpc.Code.Unknown)) {
					this.logger.info(`the local app (pid: ${config.pid}) is running, but the api endpoint is not ready: ${e}`);
					this.logger.info(`retying again after 1s delay...`);
					await new Promise(resolve => setTimeout(resolve, 1000));
					throwIfCancelled(token);
					continue;
				}
				if (running !== true) {
					this.logger.info(`the local app (pid: ${config.pid}) is not running: ${running}`);
				}
				this.logger.error(`failed to access the local app: ${e}`);
				throw e;
			}
		}
	}

	public async handleUri(uri: vscode.Uri) {
		if (uri.path === LocalApp.AUTH_COMPLETE_PATH) {
			this.logger.info('auth completed');
			return;
		}
		this.logger.info('open workspace window: ' + uri.toString());
		const params: SSHConnectionParams = JSON.parse(uri.query);
		let resolvedConfig: LocalAppConfig | undefined;
		try {
			await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				cancellable: true,
				title: `Connecting to Gitpod workspace: ${params.workspaceId}`
			}, async (_, token) => {
				const connection = await this.withLocalApp(params.gitpodHost, (client, config) => {
					resolvedConfig = config;
					const request = new ResolveSSHConnectionRequest();
					request.setInstanceId(params.instanceId);
					request.setWorkspaceId(params.workspaceId);
					return new Promise<ResolveSSHConnectionResponse>((resolve, reject) =>
						client.resolveSSHConnection(request, (e, r) => r ? resolve(r) : reject(e))
					);
				}, token);

				const config = vscode.workspace.getConfiguration('remote.SSH');
				const defaultExtensions = config.get<string[]>('defaultExtensions') || [];
				if (defaultExtensions.indexOf('gitpod.gitpod-remote-ssh') === -1) {
					defaultExtensions.unshift('gitpod.gitpod-remote-ssh');
					await config.update('defaultExtensions', defaultExtensions, vscode.ConfigurationTarget.Global);
				}
				// TODO(ak) notify a user about config file changes?
				const gitpodConfigFile = connection.getConfigFile();
				const currentConfigFile = config.get<string>('configFile');
				if (currentConfigFile === gitpodConfigFile) {
					// invalidate cached SSH targets from the current config file
					await config.update('configFile', undefined, vscode.ConfigurationTarget.Global);
				}
				await config.update('configFile', gitpodConfigFile, vscode.ConfigurationTarget.Global);
				// TODO(ak) ensure that vscode.ssh-remote is installed
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.parse(`vscode-remote://ssh-remote+${connection.getHost()}${uri.path || '/'}`), {
					forceNewWindow: true
				});
			});
		} catch (e) {
			const seeLogs = 'See Logs';
			vscode.window.showErrorMessage(`Failed to connect to Gitpod workspace ${params.workspaceId}: ${e}`, seeLogs).then(async result => {
				if (result !== seeLogs) {
					return;
				}
				this.logger.show();
				if (resolvedConfig) {
					const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolvedConfig.logPath));
					vscode.window.showTextDocument(document);
				}
			});
			this.logger.error(`failed to open uri: ${e}`);
			throw e;
		}
	}

	public async autoTunnelCommand(gitpodHost: string, instanceId: string, enabled: boolean) {
		try {
			await this.withLocalApp(gitpodHost, client => {
				const request = new AutoTunnelRequest();
				request.setInstanceId(instanceId);
				request.setEnabled(enabled);
				return new Promise<void>((resolve, reject) =>
					client.autoTunnel(request, (e, r) => r ? resolve(undefined) : reject(e))
				);
			});
		} catch (e) {
			this.logger.error('failed to disable auto tunneling', e);
		}
	}
}

/**
 * Codex CLI Handlers
 *
 * IPC handlers for Codex CLI version checking and installation.
 * Provides functionality to:
 * - Check installed vs latest version
 * - Open terminal with installation command
 */

import { ipcMain } from 'electron';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import { IPC_CHANNELS } from '../../shared/constants';
import type { IPCResult } from '../../shared/types';
import type { CodexVersionInfo, CodexInstallationList, CodexInstallationInfo } from '../../shared/types/cli';
import { getToolInfo, getCodexDetectionPaths } from '../cli-tool-manager';
import { readSettingsFile, writeSettingsFile } from '../settings-utils';
import { isSecurePath } from '../utils/windows-paths';
import semver from 'semver';
import { openTerminalWithCommand } from './claude-code-handlers';

const execFileAsync = promisify(execFile);

// Cache for latest version (avoid hammering npm registry)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
let cachedVersionList: { versions: string[]; timestamp: number } | null = null;
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERSION_LIST_CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour for version list

/**
 * Validate a Codex CLI path and get its version
 * @param cliPath - Path to the Codex CLI executable
 * @returns Tuple of [isValid, version or null]
 */
async function validateCodexCliAsync(cliPath: string): Promise<[boolean, string | null]> {
  try {
    const isWindows = process.platform === 'win32';

    // Security validation: reject paths with shell metacharacters or directory traversal
    if (isWindows && !isSecurePath(cliPath)) {
      throw new Error(`Codex CLI path failed security validation: ${cliPath}`);
    }

    // Augment PATH with the CLI directory for proper resolution
    const cliDir = path.dirname(cliPath);
    const env = {
      ...process.env,
      PATH: cliDir ? `${cliDir}${path.delimiter}${process.env.PATH || ''}` : process.env.PATH,
    };

    const result = await execFileAsync(cliPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
      env,
    });

    const version = String(result.stdout).trim();
    const match = version.match(/(\d+\.\d+\.\d+)/);
    return [true, match ? match[1] : version.split('\n')[0]];
  } catch (error) {
    console.warn('[Codex] CLI validation failed for', cliPath, ':', error);
    return [false, null];
  }
}

/**
 * Scan all known locations for Codex CLI installations.
 */
async function scanCodexInstallations(activePath: string | null): Promise<CodexInstallationInfo[]> {
  const installations: CodexInstallationInfo[] = [];
  const seenPaths = new Set<string>();
  const homeDir = os.homedir();

  const detectionPaths = getCodexDetectionPaths(homeDir);

  const addInstallation = async (
    cliPath: string,
    source: CodexInstallationInfo['source']
  ) => {
    const normalizedPath = path.resolve(cliPath);
    if (seenPaths.has(normalizedPath)) return;

    if (!existsSync(cliPath)) return;

    if (!isSecurePath(cliPath)) {
      console.warn('[Codex] Rejecting insecure path:', cliPath);
      return;
    }

    const [isValid, version] = await validateCodexCliAsync(cliPath);
    if (!isValid) return;

    seenPaths.add(normalizedPath);
    installations.push({
      path: normalizedPath,
      version,
      source,
      isActive: activePath ? path.resolve(activePath) === normalizedPath : false,
    });
  };

  // 1. Check user-configured path first
  if (activePath && existsSync(activePath)) {
    await addInstallation(activePath, 'user-config');
  }

  // 2. Check system PATH
  try {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const result = await execFileAsync('where', ['codex'], { timeout: 5000 });
      const paths = result.stdout.trim().split('\n').filter(p => p.trim());
      for (const p of paths) {
        await addInstallation(p.trim(), 'system-path');
      }
    } else {
      const result = await execFileAsync('which', ['codex'], { timeout: 5000 });
      const codexPath = result.stdout.trim();
      if (codexPath) {
        await addInstallation(codexPath, 'system-path');
      }
    }
  } catch {
    // which/where failed - codex not in PATH
  }

  // 3. Check Homebrew paths
  for (const p of detectionPaths.homebrewPaths) {
    await addInstallation(p, 'homebrew');
  }

  // 4. Check platform-specific paths
  for (const p of detectionPaths.platformPaths) {
    await addInstallation(p, 'system-path');
  }

  // Mark first installation as active if none is
  if (installations.length > 0 && !installations.some(i => i.isActive)) {
    installations[0].isActive = true;
  }

  return installations;
}

/**
 * Fetch the latest version of Codex from npm registry
 */
async function fetchLatestVersion(): Promise<string> {
  if (cachedLatestVersion && Date.now() - cachedLatestVersion.timestamp < CACHE_DURATION_MS) {
    return cachedLatestVersion.version;
  }

  try {
    const response = await fetch('https://registry.npmjs.org/@openai/codex/latest', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const version = data.version;

    if (!version || typeof version !== 'string') {
      throw new Error('Invalid version format from npm registry');
    }

    cachedLatestVersion = { version, timestamp: Date.now() };
    return version;
  } catch (error) {
    console.error('[Codex] Failed to fetch latest version:', error);
    if (cachedLatestVersion) {
      return cachedLatestVersion.version;
    }
    throw error;
  }
}

/**
 * Fetch available versions of Codex from npm registry
 */
async function fetchAvailableVersions(): Promise<string[]> {
  if (cachedVersionList && Date.now() - cachedVersionList.timestamp < VERSION_LIST_CACHE_DURATION_MS) {
    return cachedVersionList.versions;
  }

  try {
    const response = await fetch('https://registry.npmjs.org/@openai/codex', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const versions = Object.keys(data.versions || {});

    if (!versions.length) {
      throw new Error('No versions found in npm registry');
    }

    const sortedVersions = versions
      .filter(v => semver.valid(v))
      .sort((a, b) => semver.rcompare(a, b))
      .slice(0, 20);

    if (sortedVersions.length === 0) {
      throw new Error('No valid semver versions found');
    }

    cachedVersionList = { versions: sortedVersions, timestamp: Date.now() };
    return sortedVersions;
  } catch (error) {
    console.error('[Codex] Failed to fetch available versions:', error);
    if (cachedVersionList) {
      return cachedVersionList.versions;
    }
    throw error;
  }
}

/**
 * Check if a Codex CLI path indicates a Homebrew installation
 */
function isHomebrewInstallation(codexPath: string | undefined): boolean {
  if (!codexPath) return false;
  const lowerPath = codexPath.toLowerCase();
  return lowerPath.includes('homebrew') || lowerPath.includes('linuxbrew');
}

/**
 * Get the brew binary path from a Homebrew-installed Codex path
 */
function getBrewPath(codexPath: string): string {
  const binDir = path.dirname(codexPath);
  return path.join(binDir, 'brew');
}

/**
 * Get the platform-specific install command for Codex
 */
function getInstallCommand(isUpdate: boolean, codexPath?: string): string {
  if (process.platform === 'win32') {
    if (isUpdate) {
      return 'npm update -g @openai/codex';
    }
    return 'npm install -g @openai/codex';
  } else {
    if (isUpdate) {
      if (isHomebrewInstallation(codexPath) && codexPath) {
        const brewPath = getBrewPath(codexPath);
        return `pkill -x codex 2>/dev/null; sleep 1; ${brewPath} upgrade codex`;
      }
      return 'pkill -x codex 2>/dev/null; sleep 1; npm update -g @openai/codex';
    }
    return 'npm install -g @openai/codex';
  }
}

/**
 * Get the install command for a specific version
 */
function getInstallVersionCommand(version: string, codexPath?: string): string {
  if (process.platform === 'win32') {
    return `npm install -g @openai/codex@${version}`;
  } else {
    return `pkill -x codex 2>/dev/null; sleep 1; npm install -g @openai/codex@${version}`;
  }
}

/**
 * Register Codex IPC handlers
 */
export function registerCodexHandlers(): void {
  // Check Codex version
  ipcMain.handle(
    IPC_CHANNELS.CODEX_CHECK_VERSION,
    async (): Promise<IPCResult<CodexVersionInfo>> => {
      try {
        console.log('[Codex] Checking version...');

        let detectionResult;
        try {
          detectionResult = getToolInfo('codex');
          console.log('[Codex] Detection result:', JSON.stringify(detectionResult, null, 2));
        } catch (detectionError) {
          console.error('[Codex] Detection error:', detectionError);
          throw new Error(`Detection failed: ${detectionError instanceof Error ? detectionError.message : 'Unknown error'}`);
        }

        const installed = detectionResult.found ? detectionResult.version || null : null;
        console.log('[Codex] Installed version:', installed);

        let latest: string;
        try {
          console.log('[Codex] Fetching latest version from npm...');
          latest = await fetchLatestVersion();
          console.log('[Codex] Latest version:', latest);
        } catch (error) {
          console.warn('[Codex] Failed to fetch latest version:', error);
          return {
            success: true,
            data: {
              installed,
              latest: 'unknown',
              isOutdated: false,
              path: detectionResult.path,
              detectionResult,
            },
          };
        }

        let isOutdated = false;
        if (installed && latest !== 'unknown') {
          try {
            const cleanInstalled = installed.replace(/^v/, '');
            const cleanLatest = latest.replace(/^v/, '');
            isOutdated = semver.lt(cleanInstalled, cleanLatest);
          } catch {
            isOutdated = false;
          }
        }

        console.log('[Codex] Check complete:', { installed, latest, isOutdated });
        return {
          success: true,
          data: {
            installed,
            latest,
            isOutdated,
            path: detectionResult.path,
            detectionResult,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Codex] Check failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to check Codex version: ${errorMsg}`,
        };
      }
    }
  );

  // Install Codex
  ipcMain.handle(
    IPC_CHANNELS.CODEX_INSTALL,
    async (): Promise<IPCResult<{ command: string }>> => {
      try {
        let isUpdate = false;
        let codexPath: string | undefined;
        try {
          const detectionResult = getToolInfo('codex');
          isUpdate = detectionResult.found && !!detectionResult.version;
          codexPath = detectionResult.path;
          console.log('[Codex] Is update:', isUpdate, 'detected version:', detectionResult.version, 'path:', codexPath);
        } catch {
          isUpdate = false;
        }

        const command = getInstallCommand(isUpdate, codexPath);
        console.log('[Codex] Install command:', command);
        console.log('[Codex] Opening terminal...');
        await openTerminalWithCommand(command);
        console.log('[Codex] Terminal opened successfully');

        return {
          success: true,
          data: { command },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Codex] Install failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to open terminal for installation: ${errorMsg}`,
        };
      }
    }
  );

  // Get available Codex versions
  ipcMain.handle(
    IPC_CHANNELS.CODEX_GET_VERSIONS,
    async (): Promise<IPCResult<{ versions: string[] }>> => {
      try {
        console.log('[Codex] Fetching available versions...');
        const versions = await fetchAvailableVersions();
        console.log('[Codex] Found', versions.length, 'versions');
        return {
          success: true,
          data: { versions },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Codex] Get versions failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to fetch available versions: ${errorMsg}`,
        };
      }
    }
  );

  // Install a specific version of Codex
  ipcMain.handle(
    IPC_CHANNELS.CODEX_INSTALL_VERSION,
    async (_event, version: string): Promise<IPCResult<{ command: string; version: string }>> => {
      try {
        if (!version || typeof version !== 'string') {
          throw new Error('Invalid version specified');
        }

        if (!semver.valid(version)) {
          throw new Error(`Invalid version format: ${version}`);
        }

        let codexPath: string | undefined;
        try {
          const detectionResult = getToolInfo('codex');
          codexPath = detectionResult.path;
        } catch {
          // Detection failed
        }

        console.log('[Codex] Installing version:', version, 'current path:', codexPath);
        const command = getInstallVersionCommand(version, codexPath);
        console.log('[Codex] Install command:', command);
        console.log('[Codex] Opening terminal...');
        await openTerminalWithCommand(command);
        console.log('[Codex] Terminal opened successfully');

        return {
          success: true,
          data: { command, version },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Codex] Install version failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to install version: ${errorMsg}`,
        };
      }
    }
  );

  // Get all Codex CLI installations
  ipcMain.handle(
    IPC_CHANNELS.CODEX_GET_INSTALLATIONS,
    async (): Promise<IPCResult<CodexInstallationList>> => {
      try {
        console.log('[Codex] Scanning for installations...');

        let activePath: string | null = null;
        try {
          const settings = await readSettingsFile();
          activePath = settings?.codexPath || null;
        } catch {
          // Settings read failed
        }

        const installations = await scanCodexInstallations(activePath);
        console.log('[Codex] Found', installations.length, 'installations');

        return {
          success: true,
          data: {
            installations,
            activePath: installations.find(i => i.isActive)?.path || null,
          },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Codex] Get installations failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to scan installations: ${errorMsg}`,
        };
      }
    }
  );

  // Set active Codex CLI path
  ipcMain.handle(
    IPC_CHANNELS.CODEX_SET_ACTIVE_PATH,
    async (_event, cliPath: string): Promise<IPCResult<{ path: string }>> => {
      try {
        if (!cliPath || typeof cliPath !== 'string') {
          throw new Error('Invalid CLI path specified');
        }

        if (!existsSync(cliPath)) {
          throw new Error(`CLI path does not exist: ${cliPath}`);
        }

        const [isValid, version] = await validateCodexCliAsync(cliPath);
        if (!isValid) {
          throw new Error(`CLI path validation failed: ${cliPath}`);
        }

        console.log('[Codex] Setting active path:', cliPath, 'version:', version);

        const settings = await readSettingsFile() || {};
        settings.codexPath = cliPath;
        await writeSettingsFile(settings);

        return {
          success: true,
          data: { path: cliPath },
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error('[Codex] Set active path failed:', errorMsg, error);
        return {
          success: false,
          error: `Failed to set active CLI path: ${errorMsg}`,
        };
      }
    }
  );

  console.log('[IPC] Codex handlers registered');
}

/**
 * Codex CLI API for renderer process
 *
 * Provides access to Codex CLI management:
 * - Check installed vs latest version
 * - Install or update Codex
 * - Get available versions for rollback
 * - Install specific version
 */

import { IPC_CHANNELS } from '../../../shared/constants';
import type { CodexVersionInfo, CodexVersionList, CodexInstallationList } from '../../../shared/types/cli';
import { invokeIpc } from './ipc-utils';

/**
 * Result of Codex installation attempt
 */
export interface CodexInstallResult {
  success: boolean;
  data?: {
    command: string;
  };
  error?: string;
}

/**
 * Result of version check
 */
export interface CodexVersionResult {
  success: boolean;
  data?: CodexVersionInfo;
  error?: string;
}

/**
 * Result of fetching available versions
 */
export interface CodexVersionsResult {
  success: boolean;
  data?: CodexVersionList;
  error?: string;
}

/**
 * Result of installing a specific version
 */
export interface CodexInstallVersionResult {
  success: boolean;
  data?: {
    command: string;
    version: string;
  };
  error?: string;
}

/**
 * Result of getting installations
 */
export interface CodexInstallationsResult {
  success: boolean;
  data?: CodexInstallationList;
  error?: string;
}

/**
 * Result of setting active path
 */
export interface CodexSetActivePathResult {
  success: boolean;
  data?: {
    path: string;
  };
  error?: string;
}

/**
 * Codex API interface exposed to renderer
 */
export interface CodexAPI {
  /**
   * Check Codex CLI version status
   * Returns installed version, latest version, and whether update is available
   */
  checkCodexVersion: () => Promise<CodexVersionResult>;

  /**
   * Install or update Codex CLI
   * Opens the user's terminal with the install command
   */
  installCodex: () => Promise<CodexInstallResult>;

  /**
   * Get available Codex CLI versions
   * Returns list of versions sorted newest first
   */
  getCodexVersions: () => Promise<CodexVersionsResult>;

  /**
   * Install a specific version of Codex CLI
   * Opens the user's terminal with the install command for the specified version
   */
  installCodexVersion: (version: string) => Promise<CodexInstallVersionResult>;

  /**
   * Get all Codex CLI installations found on the system
   * Returns list of installations with paths, versions, and sources
   */
  getCodexInstallations: () => Promise<CodexInstallationsResult>;

  /**
   * Set the active Codex CLI path
   * Updates settings and CLI tool manager cache
   */
  setCodexActivePath: (cliPath: string) => Promise<CodexSetActivePathResult>;
}

/**
 * Creates the Codex API implementation
 */
export const createCodexAPI = (): CodexAPI => ({
  checkCodexVersion: (): Promise<CodexVersionResult> =>
    invokeIpc(IPC_CHANNELS.CODEX_CHECK_VERSION),

  installCodex: (): Promise<CodexInstallResult> =>
    invokeIpc(IPC_CHANNELS.CODEX_INSTALL),

  getCodexVersions: (): Promise<CodexVersionsResult> =>
    invokeIpc(IPC_CHANNELS.CODEX_GET_VERSIONS),

  installCodexVersion: (version: string): Promise<CodexInstallVersionResult> =>
    invokeIpc(IPC_CHANNELS.CODEX_INSTALL_VERSION, version),

  getCodexInstallations: (): Promise<CodexInstallationsResult> =>
    invokeIpc(IPC_CHANNELS.CODEX_GET_INSTALLATIONS),

  setCodexActivePath: (cliPath: string): Promise<CodexSetActivePathResult> =>
    invokeIpc(IPC_CHANNELS.CODEX_SET_ACTIVE_PATH, cliPath),
});

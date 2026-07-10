/**
 * IPC index — register all handlers.
 */

import { registerChatIPC } from "./chat.js";
import { registerFilesIPC } from "./files.js";
import { registerShellIPC } from "./shell.js";
import { registerProvidersIPC } from "./providers.js";
import { registerPermissionsIPC } from "./permissions.js";
import { registerWorkspaceIPC } from "./workspace.js";
import { registerSessionsIPC } from "./sessions.js";
import { registerSettingsIPC } from "./settings.js";
import { registerStatsIPC } from "./stats.js";
import { registerSkillsIPC } from "./skills.js";
import { registerMcpIPC } from "./mcp.js";
import { registerSttIPC } from "./stt.js";
import { registerGitIPC } from "./git.js";
import { registerCommandsIPC } from "./commands.js";
import { registerArtifactsIPC } from "./artifacts.js";

export function registerAllIPC(): void {
  registerChatIPC();
  registerFilesIPC();
  registerShellIPC();
  registerProvidersIPC();
  registerPermissionsIPC();
  registerWorkspaceIPC();
  registerSessionsIPC();
  registerSettingsIPC();
  registerStatsIPC();
  registerSkillsIPC();
  registerMcpIPC();
  registerSttIPC();
  registerGitIPC();
  registerCommandsIPC();
  registerArtifactsIPC();
}

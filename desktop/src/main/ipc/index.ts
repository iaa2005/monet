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
import { seedSkills } from "../agent/seed-skills.js";
import { registerSkillStoreIPC } from "./skill-store.js";
import { registerAgentsIPC } from "./agents.js";
import { registerMemoryIPC } from "./memory.js";
import { registerReflectIPC } from "./reflect.js";
import { registerProfileIPC } from "./profile.js";
import { registerMcpIPC } from "./mcp.js";
import { registerGoalIPC } from "./goal.js";
import { registerMcpRegistryIPC } from "./mcp-registry.js";
import { registerSttIPC } from "./stt.js";
import { registerGitIPC } from "./git.js";
import { registerCommandsIPC } from "./commands.js";
import { registerArtifactsIPC } from "./artifacts.js";
import { registerSandboxIPC } from "./sandbox.js";
import { registerConnectorsIPC } from "./connectors.js";
import { registerIncognitoIPC } from "../incognito.js";
import { registerBrowserIPC } from "./browser.js";
import { registerComputerIPC } from "./computer.js";
import { registerTuningIPC } from "./tuning.js";
import { registerTransferIPC } from "./transfer.js";
import { registerTasksIPC } from "./tasks.js";
import { registerRoutinesIPC } from "./routines.js";

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
  registerSkillStoreIPC();
  // Ships /create-skill into the user's skills folder the first time, where the
  // vendor discovers it like any other. Never overwrites, never returns.
  seedSkills();
  registerAgentsIPC();
  registerMemoryIPC();
  registerReflectIPC();
  registerProfileIPC();
  registerMcpIPC();
  registerGoalIPC();
  registerMcpRegistryIPC();
  registerSttIPC();
  registerGitIPC();
  registerCommandsIPC();
  registerArtifactsIPC();
  registerSandboxIPC();
  registerConnectorsIPC();
  registerIncognitoIPC();
  registerBrowserIPC();
  registerComputerIPC();
  registerTuningIPC();
  registerTransferIPC();
  registerRoutinesIPC();
  registerTasksIPC();
}

/**
 * IPC index — register all handlers.
 */

import { registerChatIPC } from './chat.js'
import { registerFilesIPC } from './files.js'
import { registerShellIPC } from './shell.js'
import { registerProvidersIPC } from './providers.js'
import { registerPermissionsIPC } from './permissions.js'
import { registerWorkspaceIPC } from './workspace.js'

export function registerAllIPC(): void {
  registerChatIPC()
  registerFilesIPC()
  registerShellIPC()
  registerProvidersIPC()
  registerPermissionsIPC()
  registerWorkspaceIPC()
}

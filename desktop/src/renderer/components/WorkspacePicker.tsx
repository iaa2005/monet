import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import type { ElectronAPI } from '@/types/electron'

export function WorkspacePicker(): JSX.Element {
  const [workspace, setWorkspace] = useState('')
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI
    api.workspace.get().then(setWorkspace)
  }, [])

  const handlePick = async (): Promise<void> => {
    setPicking(true)
    try {
      const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI
      const dir = await api.files.pickDirectory()
      if (dir) {
        await api.workspace.set(dir)
        setWorkspace(dir)
      }
    } finally {
      setPicking(false)
    }
  }

  const displayPath = workspace
    ? workspace.split(/[/\\]/).slice(-2).join('/')
    : '...'

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handlePick}
      disabled={picking}
      className="text-xs text-muted-foreground"
      title={workspace}
    >
      📁 {displayPath}
    </Button>
  )
}

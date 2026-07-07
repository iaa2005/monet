/**
 * Terminal component using xterm.js + IPC shell.
 *
 * Each command runs via child_process.exec (no PTY for MVP).
 * Output is appended to the terminal buffer.
 */

import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import type { ElectronAPI } from '@/types/electron'

export function Terminal(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const inputBuffer = useRef('')

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'monospace',
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
      },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term

    // Welcome
    term.writeln('Claude Code Desktop — Terminal')
    term.writeln('Type commands and press Enter. Ctrl+C to cancel.')
    term.write('\r\n$ ')

    const api = (window as unknown as { electronAPI: ElectronAPI }).electronAPI

    // Handle input
    term.onData(async (data) => {
      if (data === '\r') {
        // Enter — execute
        const cmd = inputBuffer.current.trim()
        term.write('\r\n')

        if (cmd === 'clear' || cmd === 'cls') {
          term.clear()
        } else if (cmd) {
          try {
            const result = await api.shell.run(cmd)
            if (result.stdout) term.write(result.stdout)
            if (result.stderr) term.write(result.stderr)
            if (result.error) term.write(`\x1b[31m${result.error}\x1b[0m`)
          } catch (err) {
            term.write(`\x1b[31mError: ${err}\x1b[0m`)
          }
        }

        inputBuffer.current = ''
        term.write('\r\n$ ')
      } else if (data === '\x7f') {
        // Backspace
        if (inputBuffer.current.length > 0) {
          inputBuffer.current = inputBuffer.current.slice(0, -1)
          term.write('\b \b')
        }
      } else if (data === '\x03') {
        // Ctrl+C
        term.write('^C\r\n$ ')
        inputBuffer.current = ''
      } else if (data >= ' ') {
        inputBuffer.current += data
        term.write(data)
      }
    })

    // Resize
    const handleResize = () => fit.fit()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      term.dispose()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ padding: '4px' }}
    />
  )
}

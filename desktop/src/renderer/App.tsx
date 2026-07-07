import { useState } from 'react'

export default function App(): JSX.Element {
  const [count, setCount] = useState(0)

  return (
    <div className="flex h-screen flex-col items-center justify-center bg-background text-foreground">
      <h1 className="text-3xl font-bold mb-4">Claude Code Desktop</h1>
      <p className="text-muted-foreground mb-4">Electron + React + shadcn/ui</p>
      <button
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90"
        onClick={() => setCount((c) => c + 1)}
      >
        Count: {count}
      </button>
    </div>
  )
}

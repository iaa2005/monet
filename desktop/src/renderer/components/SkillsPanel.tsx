import { useSkillsStore } from '@/stores/skillsStore'
import { cn } from '@/lib/utils'

export function SkillsPanel(): JSX.Element {
  const { skills, toggleSkill } = useSkillsStore()
  const active = skills.filter(s => s.enabled).length

  return (
    <div className="p-4">
      <h2 className="mb-3 text-lg font-semibold">
        Skills{' '}
        <span className="text-sm font-normal text-muted-foreground">
          ({active} active)
        </span>
      </h2>

      <div className="grid gap-2 sm:grid-cols-2">
        {skills.map(skill => (
          <button
            key={skill.name}
            onClick={() => toggleSkill(skill.name)}
            className={cn(
              'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors',
              skill.enabled
                ? 'border-primary bg-primary/5'
                : 'border-muted bg-background hover:bg-accent/50',
            )}
          >
            <div
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0 rounded border-2',
                skill.enabled
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground/30',
              )}
            >
              {skill.enabled && (
                <svg viewBox="0 0 24 24" className="h-full w-full text-primary-foreground">
                  <path
                    fill="currentColor"
                    d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"
                  />
                </svg>
              )}
            </div>
            <div>
              <p className="text-sm font-medium">{skill.name}</p>
              <p className="text-xs text-muted-foreground">{skill.description}</p>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

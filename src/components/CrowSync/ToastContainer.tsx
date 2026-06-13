import type { Toast } from '../../hooks/useToast'

interface ToastContainerProps {
  toasts: Toast[]
  onRemove: (id: number) => void
}

const TYPE_STYLES: Record<string, { cls: string; shadow: string }> = {
  error:   { cls: 'border-danger   bg-danger/10   text-danger',  shadow: '3px 3px 0px var(--color-danger)' },
  success: { cls: 'border-sync     bg-sync/10     text-sync',    shadow: '3px 3px 0px var(--color-sync)' },
  info:    { cls: 'border-pull     bg-pull/10     text-pull',    shadow: '3px 3px 0px var(--color-pull)' },
}

export function ToastContainer({ toasts, onRemove }: ToastContainerProps) {
  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-12 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map(t => {
        const style = TYPE_STYLES[t.type] || TYPE_STYLES.info
        return (
          <div
            key={t.id}
            onClick={() => onRemove(t.id)}
            className={`border-[1.5px] rounded px-3 py-2 text-[12px] font-medium cursor-pointer backdrop-blur-sm animate-[slideIn_0.2s_ease-out] transition-all hover:translate-x-[1px] hover:translate-y-[1px] active:translate-x-[3px] active:translate-y-[3px] ${style.cls}`}
            style={{ boxShadow: style.shadow }}
          >
            {t.message}
          </div>
        )
      })}
    </div>
  )
}

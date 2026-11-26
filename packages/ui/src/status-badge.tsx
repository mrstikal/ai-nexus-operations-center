import type { ReactNode } from 'react';

export const STATUS_TONES = ['info', 'review', 'danger', 'success', 'neutral'] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

export interface StatusBadgeProps {
  readonly tone?: StatusTone;
  readonly children: ReactNode;
  readonly icon?: ReactNode;
}

export function StatusBadge({ tone = 'neutral', children, icon }: StatusBadgeProps) {
  return (
    <span className={`nexus-status nexus-status--${tone}`} data-tone={tone}>
      <span className="nexus-status__icon" aria-hidden="true">
        {icon ?? <span className="nexus-status__dot" />}
      </span>
      <span className="nexus-status__label">{children}</span>
    </span>
  );
}

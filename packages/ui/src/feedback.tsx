import type { ReactNode } from 'react';

export const FEEDBACK_VARIANTS = [
  'loading',
  'empty',
  'error',
  'read-only',
  'notice',
] as const;
export type FeedbackVariant = (typeof FEEDBACK_VARIANTS)[number];

const ICONS: Record<FeedbackVariant, string> = {
  loading: '…',
  empty: '○',
  error: '!',
  'read-only': '◐',
  notice: 'i',
};

export interface FeedbackProps {
  readonly variant: FeedbackVariant;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly testId?: string;
}

export function Feedback({ variant, title, children, action, testId }: FeedbackProps) {
  const role = variant === 'error' || variant === 'read-only' ? 'alert' : undefined;
  return (
    <section
      className={`nexus-feedback nexus-feedback--${variant}`}
      data-variant={variant}
      data-testid={testId}
      role={role}
      aria-live={variant === 'loading' ? 'polite' : undefined}
    >
      <span className="nexus-feedback__icon" aria-hidden="true">
        {ICONS[variant]}
      </span>
      <div className="nexus-feedback__body">
        <h2 className="nexus-feedback__title">{title}</h2>
        {children ? <div className="nexus-feedback__text">{children}</div> : null}
        {action ? <div className="nexus-feedback__action">{action}</div> : null}
      </div>
    </section>
  );
}

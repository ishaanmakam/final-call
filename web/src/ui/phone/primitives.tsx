import { motion } from 'motion/react';
import type { CSSProperties, ReactNode } from 'react';
import { memberById, type Member, type MemberId, type ResultStatus, type World } from '../../sim';
import { spring, useReducedMotion } from '../motion';
import { glossary, type StateName } from '../tokens';

export type PillTone = StateName | 'tint';

/** `status.ts` in the app: a settled Unverified moved no money, so it is drawn neutral. */
export const resultPill: Record<ResultStatus, { label: string; tone: PillTone }> = {
  pending: { label: glossary.pending, tone: 'pending' },
  success: { label: glossary.success, tone: 'success' },
  failed: { label: glossary.failed, tone: 'forfeit' },
  unverified: { label: glossary.unverified, tone: 'pending' },
  frozen: { label: glossary.frozen, tone: 'frozen' },
  void: { label: glossary.void, tone: 'void' },
  excluded: { label: glossary.excluded, tone: 'excluded' },
};

export function Pill({ tone, children, compact, className = '' }: { tone: PillTone; children: ReactNode; compact?: boolean; className?: string }) {
  return <span className={`pill ${tone} ${compact ? 'compact' : ''} ${className}`}>{children}</span>;
}

export function ResultPill({ status, compact }: { status: ResultStatus; compact?: boolean }) {
  const p = resultPill[status];
  return (
    <Pill tone={p.tone} {...(compact ? { compact } : {})}>
      {p.label}
    </Pill>
  );
}

export function Avatar({ member, size = 32, you = false, highlight = false, single = false }: { member: Member; size?: number; you?: boolean; highlight?: boolean; single?: boolean }) {
  const ring = you || highlight;
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.round(size * 0.36),
    background: `var(--avatar-${member.avatar}-bg)`,
    color: `var(--avatar-${member.avatar}-fg)`,
    boxShadow: ring ? `0 0 0 2px var(--tint)` : 'none',
  };
  const initials = single || size < 28 ? member.initials[0] : member.initials;
  return (
    <span className="avatar" style={style} role="img" aria-label={member.name}>
      {initials}
    </span>
  );
}

/** 28–32 pt initials circles overlapping 30%, a bg ring between them, tint ring on the people "in". */
export function AvatarStack({ w, ids, highlight, size = 32 }: { w: World; ids: MemberId[]; highlight: MemberId[]; size?: number }) {
  return (
    <div className="avatar-stack" aria-label={`${ids.length} people`} style={{ height: size + 4 }}>
      {ids.map((id, i) => (
        <span key={id} className="avatar-wrap" style={{ marginLeft: i === 0 ? 0 : -Math.round(size * 0.3), zIndex: ids.length - i }}>
          <Avatar member={memberById(w, id)} size={size} highlight={highlight.includes(id)} single />
        </span>
      ))}
    </div>
  );
}

export function Card({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`p-card ${className}`} style={style}>
      {children}
    </div>
  );
}

export function PButton({
  children,
  variant = 'primary',
  small,
  onClick,
  disabled,
  ariaLabel,
  block,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'tertiary' | 'destructive';
  small?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  block?: boolean;
}) {
  return (
    <button
      type="button"
      className={`p-btn ${variant} ${small ? 'small' : ''} ${block ? 'block' : ''}`}
      onClick={onClick}
      disabled={disabled}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
    >
      {children}
    </button>
  );
}

/**
 * ProgressRing: an SVG stroke. `animate="spring"` moves with the reveal spring; `"step"` jumps
 * (a ticking clock is redrawn, never interpolated); `indeterminate` sweeps a quarter arc.
 */
export function ProgressRing({
  size,
  strokeWidth,
  progress,
  color = 'var(--tint)',
  track = 'var(--fill-strong)',
  animate = 'spring',
  indeterminate = false,
  dashed = false,
  children,
  label,
}: {
  size: number;
  strokeWidth: number;
  progress: number;
  color?: string;
  track?: string;
  animate?: 'spring' | 'step';
  indeterminate?: boolean;
  dashed?: boolean;
  children?: ReactNode;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const r = (size - strokeWidth) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, progress));
  const offset = c * (1 - clamped);
  return (
    <div className="ring" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden={!label}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={strokeWidth} />
        {indeterminate ? (
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${c / 4} ${c}`}
            style={{ transformOrigin: '50% 50%' }}
            animate={reduced ? { opacity: [1, 0.45, 1] } : { rotate: 360 }}
            transition={reduced ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 1.2, repeat: Infinity, ease: 'linear' }}
          />
        ) : (
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={dashed ? `${strokeWidth * 1.5} ${strokeWidth * 1.5}` : c}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            initial={false}
            animate={{ strokeDashoffset: dashed ? 0 : offset, stroke: color }}
            transition={animate === 'step' || reduced ? { duration: 0 } : spring('reveal')}
          />
        )}
      </svg>
      {children ? <div className="ring-center">{children}</div> : null}
    </div>
  );
}

export function Icon({ name, size = 20, color = 'currentColor' }: { name: 'check' | 'location' | 'review' | 'chevron' | 'share' | 'more' | 'x' | 'warning'; size?: number; color?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'check':
      return (
        <svg {...common}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    case 'location':
      return (
        <svg {...common}>
          <path d="M21 3L10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7z" />
        </svg>
      );
    case 'review':
      return (
        <svg {...common}>
          <path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common}>
          <path d="M9 6l6 6-6 6" />
        </svg>
      );
    case 'share':
      return (
        <svg {...common}>
          <path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
        </svg>
      );
    case 'more':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="8" cy="12" r="0.8" fill={color} />
          <circle cx="12" cy="12" r="0.8" fill={color} />
          <circle cx="16" cy="12" r="0.8" fill={color} />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M12 9v4M12 17h.01M10.3 3.9L2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
        </svg>
      );
  }
}

/** The small pieces every page shares. */
import type { ReactNode } from 'react';

export function Banner({ kind = 'info', children }: {
  kind?: 'info' | 'error' | 'good';
  children: ReactNode;
}) {
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Card({ children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className="card" {...rest}>{children}</div>;
}

export function Field({ label, help, children }: {
  label: string; help?: string; children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {help ? <span className="help faint">{help}</span> : null}
    </label>
  );
}

export function Check({ label, checked, onChange, help }: {
  label: string; checked: boolean; onChange: (v: boolean) => void; help?: string;
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {help ? <span className="faint" style={{ display: 'block' }}>{help}</span> : null}
      </span>
    </label>
  );
}

export function Pill({ tone = '', children }: { tone?: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 10, color: 'var(--ink-soft)' }}>
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** A progress rail, 0..1. */
export function Rail({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return <div className="progress-rail"><i style={{ width: `${pct}%` }} /></div>;
}

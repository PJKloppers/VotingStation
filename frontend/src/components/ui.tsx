/** The small pieces every page shares. */
import { useEffect, useRef } from 'react';
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

/**
 * A modal.
 *
 * Native `<dialog>`, so the focus trap, the Esc key and the inert background
 * are the browser's job rather than ours. Clicking the backdrop closes it --
 * the backdrop is part of the element, so the click lands on the dialog itself.
 */
export function Modal({ open, title, onClose, children }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="modal-head">
        <h2 className="grow">{title}</h2>
        <button className="ghost small" onClick={onClose}>Close</button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

/** A progress rail, 0..1. */
export function Rail({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return <div className="progress-rail"><i style={{ width: `${pct}%` }} /></div>;
}

/**
 * One numbered step of a form that asks for things in order.
 *
 * Used where asking for everything at once would mean asking for things that
 * make no sense yet -- adding a question, starting a ballot. The steps stay on
 * screen once passed, so going back to change an earlier answer is scrolling
 * up rather than starting again.
 */
export function Step({ n, title, children }: {
  n: number; title: string; children: React.ReactNode;
}) {
  return (
    <section className="step">
      <p className="step-head"><span className="step-n">{n}</span>{title}</p>
      {children}
    </section>
  );
}

/**
 * The question editor.
 *
 * Each type is stored in its own table, so each type gets its own settings
 * block here and its own accessor in the API. Adding a type means adding a
 * table, a row in `question_types`, and one branch below -- nothing that
 * already works has to change.
 */
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { AnyQuestion } from '../lib/api';
import { parseOptionList } from '../lib/options';
import type { QuestionOption, QuestionType } from '../lib/types';
import { QUESTION_TYPE_NAMES } from '../lib/types';
import { Banner, Card, Check, Empty, Field, Pill, Spinner } from '../components/ui';

export function Questions({ ballotId }: { ballotId: string }) {
  const [questions, setQuestions] = useState<AnyQuestion[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<QuestionType>('yes_no');
  const [prompt, setPrompt] = useState('');

  const load = useCallback(async () => {
    try {
      setQuestions(await api.questionsForBallot(ballotId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the questions.');
      setQuestions([]);
    }
  }, [ballotId]);

  useEffect(() => { void load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.createQuestion(adding, ballotId, prompt, (questions?.length ?? 0) + 1);
      setPrompt('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it.');
    }
  };

  if (questions === null) return <Spinner label="Loading questions" />;

  return (
    <div className="stack">
      {error ? <Banner kind="error">{error}</Banner> : null}

      {questions.length === 0
        ? <Empty>No questions yet. Add the first one below.</Empty>
        : questions.map((q) => (
            <QuestionCard key={`${q.type}:${q.id}`} question={q} onChanged={load} />
          ))}

      <Card>
        <h3>Add a question</h3>
        <form onSubmit={add}>
          <Field label="Type">
            <select value={adding} onChange={(e) => setAdding(e.target.value as QuestionType)}>
              {(Object.keys(QUESTION_TYPE_NAMES) as QuestionType[]).map((t) => (
                <option key={t} value={t}>{QUESTION_TYPE_NAMES[t]}</option>
              ))}
            </select>
          </Field>
          <Field label="Question">
            <input required value={prompt} name="new_question"
                   onChange={(e) => setPrompt(e.target.value)}
                   placeholder={adding === 'yes_no' ? 'Adopt the 2026 budget' : 'Elect the Chairperson'} />
          </Field>
          <button type="submit" className="primary" disabled={!prompt.trim()}>Add question</button>
        </form>
      </Card>
    </div>
  );
}

function QuestionCard({ question, onChanged }: { question: AnyQuestion; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const value = <K extends keyof AnyQuestion>(key: K): AnyQuestion[K] =>
    (key in draft ? draft[key as string] : question[key]) as AnyQuestion[K];

  const set = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }));

  const save = async () => {
    if (Object.keys(draft).length === 0) return;
    setSaving(true); setError('');
    try {
      await api.updateQuestion(question.type, question.id, draft);
      setDraft({});
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${question.prompt}" and every vote on it?`)) return;
    await api.deleteQuestion(question.type, question.id);
    onChanged();
  };

  return (
    <Card>
      <div className="row">
        <div className="grow">
          <p className="eyebrow">{QUESTION_TYPE_NAMES[question.type]}</p>
          <h3>{question.prompt}</h3>
        </div>
        {question.gate_open ? <Pill tone="open">Gate open</Pill> : null}
        <button className="ghost small" onClick={() => setOpen(!open)}>
          {open ? 'Done' : 'Edit'}
        </button>
      </div>

      {!open ? null : (
        <div style={{ marginTop: 16 }}>
          {error ? <Banner kind="error">{error}</Banner> : null}

          <Field label="Question">
            <input value={String(value('prompt'))} onChange={(e) => set('prompt', e.target.value)} />
          </Field>
          <Field label="Description" help="Optional. Shown under the question.">
            <textarea value={String(value('description'))}
                      onChange={(e) => set('description', e.target.value)} />
          </Field>
          <div className="row">
            <div className="grow">
              <Field label="Order">
                <input type="number" value={Number(value('sort_order'))}
                       onChange={(e) => set('sort_order', Number(e.target.value))} />
              </Field>
            </div>
          </div>
          <TypeSettings question={question} value={value as (k: string) => unknown} set={set} />

          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" onClick={() => void save()}
                    disabled={saving || Object.keys(draft).length === 0}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button className="danger row-end" onClick={() => void remove()}>Delete question</button>
          </div>

          {question.type !== 'yes_no'
            ? <Options type={question.type} questionId={question.id} />
            : null}
        </div>
      )}
    </Card>
  );
}

/** The block of settings unique to one type. */
function TypeSettings({ question, value, set }: {
  question: AnyQuestion; value: (k: string) => unknown; set: (k: string, v: unknown) => void;
}) {
  if (question.type === 'yes_no') {
    return (
      <>
        <div className="row">
          <div className="grow">
            <Field label="Yes label">
              <input value={String(value('yes_label'))} onChange={(e) => set('yes_label', e.target.value)} />
            </Field>
          </div>
          <div className="grow">
            <Field label="No label">
              <input value={String(value('no_label'))} onChange={(e) => set('no_label', e.target.value)} />
            </Field>
          </div>
        </div>
        <Check label="Allow abstentions" checked={Boolean(value('allow_abstain'))}
               onChange={(v) => set('allow_abstain', v)}
               help="Abstentions are counted and reported, but do not count towards the threshold." />
        <div className="row">
          <div className="grow">
            <Field label="Threshold" help="As a fraction of the decisive votes.">
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <input type="number" min={0} style={{ width: 70 }}
                       value={Number(value('pass_num'))}
                       onChange={(e) => set('pass_num', Number(e.target.value))} />
                <span aria-hidden="true">/</span>
                <input type="number" min={1} style={{ width: 70 }}
                       value={Number(value('pass_den'))}
                       onChange={(e) => set('pass_den', Number(e.target.value))} />
              </div>
            </Field>
          </div>
        </div>
        <Check label="Must exceed the threshold" checked={Boolean(value('threshold_strict'))}
               onChange={(v) => set('threshold_strict', v)}
               help="On: 1/2 means more than half — a simple majority, where a tie fails. Off: 2/3 means at least two thirds." />
      </>
    );
  }

  if (question.type === 'highest_outright') {
    return (
      <>
        <Check label="Winner must take an outright majority" checked={Boolean(value('require_majority'))}
               onChange={(v) => set('require_majority', v)}
               help="Without more than half the votes cast, the result is reported as no outright winner." />
        <Check label="Allow abstentions" checked={Boolean(value('allow_abstain'))}
               onChange={(v) => set('allow_abstain', v)} />
      </>
    );
  }

  return (
    <div className="row">
      <div className="grow">
        <Field label="Minimum picks">
          <input type="number" min={1} value={Number(value('select_min'))}
                 onChange={(e) => set('select_min', Number(e.target.value))} />
        </Field>
      </div>
      <div className="grow">
        <Field label="Maximum picks">
          <input type="number" min={1} value={Number(value('select_max'))}
                 onChange={(e) => set('select_max', Number(e.target.value))} />
        </Field>
      </div>
      <div className="grow">
        <Field label="Seats" help="How many are elected.">
          <input type="number" min={1} value={Number(value('winner_count'))}
                 onChange={(e) => set('winner_count', Number(e.target.value))} />
        </Field>
      </div>
    </div>
  );
}

function Options({ type, questionId }: { type: QuestionType; questionId: string }) {
  const [options, setOptions] = useState<QuestionOption[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setOptions(await api.optionsForQuestion(type, questionId));
  }, [type, questionId]);

  useEffect(() => { void load(); }, [load]);

  const parsed = parseOptionList(draft, (options ?? []).map((o) => o.label));

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await api.createOptions(type, questionId, parsed.labels, (options?.length ?? 0) + 1);
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add them.');
    } finally {
      setBusy(false);
    }
  };

  if (options === null) return null;

  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--rule-soft)' }}>
      <h3>Options</h3>
      {error ? <Banner kind="error">{error}</Banner> : null}
      {options.length === 0 ? <p className="faint">No options yet.</p> : null}

      {options.map((o) => (
        <div key={o.id} className="row" style={{ marginBottom: 8 }}>
          <input className="grow" name="option_label" defaultValue={o.label}
                 onBlur={(e) => {
                   if (e.target.value !== o.label) {
                     void api.updateOption(type, o.id, { label: e.target.value }).then(load);
                   }
                 }} />
          <button className="ghost small" onClick={() => void api.updateOption(type, o.id, { enabled: !o.enabled }).then(load)}>
            {o.enabled ? 'Disable' : 'Enable'}
          </button>
          <button className="danger small"
                  onClick={() => { if (confirm(`Remove "${o.label}"?`)) void api.deleteOption(type, o.id).then(load); }}>
            Remove
          </button>
        </div>
      ))}

      {/* One control for one name or a whole column pasted out of a
          spreadsheet -- the parser takes commas, newlines and quoted fields
          alike, so there is no mode to choose first. */}
      <form onSubmit={add} style={{ marginTop: 14 }}>
        <Field label="Add options"
               help="One per line, or comma separated. Paste a column straight from a spreadsheet.">
          <textarea
            name="new_options"
            value={draft}
            rows={draft.includes('\n') ? 5 : 2}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={'Ann Meyer\nBen Naidoo\nCara Dlamini'}
          />
        </Field>

        {parsed.duplicates.length > 0 ? (
          <p className="faint">
            Already on the question, and skipped: {parsed.duplicates.join(', ')}
          </p>
        ) : null}
        {parsed.tooLong.length > 0 ? (
          <Banner kind="error">
            Too long to be an option: {parsed.tooLong.map((l) => `"${l.slice(0, 40)}…"`).join(', ')}
          </Banner>
        ) : null}

        <button type="submit" className="ghost" disabled={busy || parsed.labels.length === 0}>
          {busy ? 'Adding…'
            : parsed.labels.length > 1 ? `Add ${parsed.labels.length} options`
            : 'Add option'}
        </button>
      </form>
    </div>
  );
}

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
import type { OptionPool, QuestionOption, QuestionType } from '../lib/types';
import { QUESTION_TYPE_NAMES } from '../lib/types';
import { Banner, Card, Check, Empty, Field, Pill, Spinner, Step } from '../components/ui';

export function Questions({ ballotId }: { ballotId: string }) {
  const [questions, setQuestions] = useState<AnyQuestion[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setQuestions(await api.questionsForBallot(ballotId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the questions.');
      setQuestions([]);
    }
  }, [ballotId]);

  useEffect(() => { void load(); }, [load]);

  if (questions === null) return <Spinner label="Loading questions" />;

  return (
    <div className="stack">
      {error ? <Banner kind="error">{error}</Banner> : null}

      {questions.length === 0
        ? <Empty>No questions yet. Add the first one below.</Empty>
        : questions.map((q) => (
            <QuestionCard key={`${q.type}:${q.id}`} question={q} onChanged={load} />
          ))}

      <AddQuestion ballotId={ballotId} after={questions.length} onAdded={load} />
    </div>
  );
}


/**
 * The three kinds of question, in the words an organizer would use.
 *
 * The type names in the database are accurate and no help at the moment of
 * choosing: "Highest outright" and "Highest X options" differ by one word and
 * by everything else. Each is named for what it decides and shown with the
 * sentence that separates it from its neighbour.
 */
const KINDS: Array<{
  type: QuestionType; title: string; blurb: string; example: string; action: string;
}> = [
  {
    type: 'yes_no',
    title: 'A motion',
    blurb: 'Carried or defeated, on a threshold you set.',
    example: 'Adopt the 2026 budget',
    action: 'Add this motion',
  },
  {
    type: 'highest_outright',
    title: 'One winner',
    blurb: 'The option with the most votes takes it.',
    example: 'Elect the Chairperson',
    action: 'Add this election',
  },
  {
    type: 'highest_x',
    title: 'Several winners',
    blurb: 'The top few take seats — you say how many.',
    example: 'Elect three to the committee',
    // the same words as the one above it: both are elections, and a label bent
    // out of the card's title read "Add this several winners"
    action: 'Add this election',
  },
];

/**
 * Adding a question, in one pass.
 *
 * It used to take two. The form made a question out of a type and a prompt,
 * and everything that made it a usable question -- the names standing for
 * election, how many seats there were -- lived in the editor on the card it
 * had just made. So an organizer added a question, hunted for it, opened it,
 * and filled it in, having already told the form what it was for.
 *
 * Now the form asks for what the chosen kind actually needs and nothing else:
 * a motion is a sentence, an election is a sentence and a list of names. The
 * per-question editor is still there for changing any of it afterwards.
 */
/**
 * Adding a question, a step at a time.
 *
 * It used to take two passes: the form made a stub out of a type and a
 * sentence, and everything that made it a usable question lived in the editor
 * on the card it had just made. Then it was one long form, which asked for
 * everything at once and so asked for things that make no sense yet.
 *
 * So it is a flow. Each step appears when the one before it is answered, and
 * each asks only what that kind of question actually has. The order is not
 * arbitrary: the votes come last because they are bounded by the options --
 * you cannot say "pick three" before there are three to pick from, and the
 * form knows how many there are only once they have been given.
 *
 * The steps stay on screen once passed, so going back to change an earlier
 * answer is scrolling up rather than starting again.
 */
function AddQuestion({ ballotId, after, onAdded }: {
  ballotId: string; after: number; onAdded: () => Promise<void> | void;
}) {
  const [kind, setKind] = useState<QuestionType | null>(null);
  const [prompt, setPrompt] = useState('');
  const [names, setNames] = useState('');
  const [pool, setPool] = useState('');
  const [poolSize, setPoolSize] = useState(0);
  const [pools, setPools] = useState<OptionPool[] | null>(null);
  const [seats, setSeats] = useState(1);
  const [least, setLeast] = useState(1);
  const [most, setMost] = useState(1);
  const [mostTouched, setMostTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = KINDS.find((k) => k.type === kind) ?? null;
  const wantsOptions = kind === 'highest_outright' || kind === 'highest_x';
  const wantsVotes = kind === 'highest_x';
  const parsed = parseOptionList(names);
  const optionCount = parsed.labels.length + poolSize;

  useEffect(() => {
    let live = true;
    api.myOptionPools()
      .then((p) => { if (live) setPools(p); })
      .catch(() => { if (live) setPools([]); });
    return () => { live = false; };
  }, []);

  // A pool contributes to the count the votes below are bounded by, so its size
  // has to be known here and not merely at submit.
  useEffect(() => {
    let live = true;
    if (!pool) { setPoolSize(0); return; }
    api.poolEntries(pool)
      .then((e) => { if (live) setPoolSize(e.length); })
      .catch(() => { if (live) setPoolSize(0); });
    return () => { live = false; };
  }, [pool]);

  // The usual shape is "pick as many as there are seats", so the maximum
  // follows the seats until somebody says otherwise.
  useEffect(() => {
    if (!mostTouched) setMost(seats);
  }, [seats, mostTouched]);

  const tooManySeats = wantsVotes && optionCount > 0 && seats > optionCount;
  const tooManyPicks = wantsVotes && optionCount > 0 && most > optionCount;
  const backwards = wantsVotes && least > most;
  const votesWrong = tooManySeats || tooManyPicks || backwards;

  /*
   * Options are not required to add the question. An organizer who knows the
   * election is happening but not yet who is standing should be able to put it
   * on the ballot and fill it in later -- the editor on its card is there for
   * exactly that. What is refused is a contradiction: more seats than options,
   * or a minimum above the maximum.
   */
  const ready = kind !== null && prompt.trim() !== '' && !votesWrong;

  const reset = () => {
    setKind(null); setPrompt(''); setNames(''); setPool(''); setPoolSize(0);
    setSeats(1); setLeast(1); setMost(1); setMostTouched(false);
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!kind) return;
    setBusy(true); setError('');
    try {
      const extra = kind === 'highest_x'
        ? { winner_count: seats, select_min: least, select_max: most }
        : {};
      const made = await api.createQuestion(kind, ballotId, prompt.trim(), after + 1, extra);

      if (wantsOptions && parsed.labels.length > 0) {
        await api.createOptions(kind, made.id, parsed.labels, 1);
      }
      if (wantsOptions && pool) {
        await api.copyPoolIntoQuestion(pool, kind, made.id);
      }

      reset();
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add it.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h3>Add a question</h3>
      {error ? <Banner kind="error">{error}</Banner> : null}

      <form onSubmit={add}>
        <Step n={1} title="What kind of question?">
          <div className="kind-choice" role="radiogroup" aria-label="What kind of question">
            {KINDS.map((k) => (
              <button
                key={k.type}
                type="button"
                role="radio"
                aria-checked={kind === k.type}
                className={`kind${kind === k.type ? ' picked' : ''}`}
                onClick={() => { setKind(k.type); setError(''); }}
              >
                <span className="kind-title">{k.title}</span>
                <span className="kind-blurb">{k.blurb}</span>
              </button>
            ))}
          </div>
        </Step>

        {chosen ? (
          <Step n={2} title="What is being asked?">
            <Field label="Question">
              <input required autoFocus value={prompt} name="new_question"
                     onChange={(e) => setPrompt(e.target.value)}
                     placeholder={chosen.example} />
            </Field>
          </Step>
        ) : null}

        {chosen && wantsOptions && prompt.trim() ? (
          <Step n={3} title="What can be voted for?">
            <Field label="Options"
                   help="One per line, or comma separated. Paste a column straight from a spreadsheet.">
              <textarea name="add_options" rows={4} value={names}
                        onChange={(e) => setNames(e.target.value)}
                        placeholder={'Ann Meyer\nBob Ncube\nCyd Patel'} />
            </Field>

            <Field label="Or take a list you already keep"
                   help={pools && pools.length === 0
                     ? 'You have no option pools yet. Pools is where you keep a list once and reuse it.'
                     : 'Added on top of anything typed above.'}>
              <select name="add_pool" value={pool}
                      disabled={!pools || pools.length === 0}
                      onChange={(e) => setPool(e.target.value)}>
                <option value="">
                  {pools && pools.length === 0 ? 'No pools yet' : 'No pool'}
                </option>
                {(pools ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </Field>

            <p className="faint">
              {optionCount === 0
                ? 'Nothing to vote for yet.'
                : `${optionCount} option${optionCount === 1 ? '' : 's'}`}
              {parsed.labels.length > 0 && poolSize > 0
                ? ` — ${parsed.labels.length} typed and ${poolSize} from the pool` : ''}
              {parsed.duplicates.length > 0
                ? ` · ${parsed.duplicates.length} repeated and dropped` : ''}
            </p>
          </Step>
        ) : null}

        {chosen && wantsVotes && optionCount > 0 ? (
          <Step n={4} title="How does the voting work?">
            <div className="row vote-rules">
              <Field label="Seats" help="How many are elected.">
                <input type="number" min={1} name="add_seats" value={seats}
                       onChange={(e) => setSeats(Math.max(1, Number(e.target.value)))} />
              </Field>
              <Field label="Pick at least" help="Fewest a voter may choose.">
                <input type="number" min={1} name="add_min" value={least}
                       onChange={(e) => setLeast(Math.max(1, Number(e.target.value)))} />
              </Field>
              <Field label="Pick at most" help="Most a voter may choose.">
                <input type="number" min={1} name="add_max" value={most}
                       onChange={(e) => { setMostTouched(true); setMost(Math.max(1, Number(e.target.value))); }} />
              </Field>
            </div>

            {votesWrong ? (
              <Banner kind="error">
                {backwards
                  ? 'The fewest a voter may pick cannot be more than the most.'
                  : tooManySeats
                    ? `There are only ${optionCount} options, so there cannot be ${seats} seats.`
                    : `There are only ${optionCount} options, so nobody can pick ${most}.`}
              </Banner>
            ) : (
              <p className="faint">
                Each voter picks {least === most ? `exactly ${least}` : `between ${least} and ${most}`}
                {' '}of the {optionCount}. The top {seats} {seats === 1 ? 'is' : 'are'} elected.
              </p>
            )}
          </Step>
        ) : null}

        {chosen ? (
          <>
            <button type="submit" className="primary" disabled={busy || !ready}>
              {busy ? 'Adding…' : chosen.action}
            </button>
            {/* A disabled button with no reason beside it is a dead end, and
                this one has four ways of being disabled. */}
            {!ready && !busy ? (
              <p className="faint" style={{ marginTop: 8 }}>
                {prompt.trim() === ''
                  ? 'Type the question above first.'
                  : 'Check the voting rules above.'}
              </p>
            ) : null}
            {ready && !busy && wantsOptions && optionCount === 0 ? (
              <p className="faint" style={{ marginTop: 8 }}>
                Nothing to vote for yet — you can add the options now or from the
                question itself later.
              </p>
            ) : null}
          </>
        ) : null}
      </form>
    </Card>
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
        <Field label="Seats">
          <input type="number" min={1} value={Number(value('winner_count'))}
                 onChange={(e) => set('winner_count', Number(e.target.value))} />
        </Field>
      </div>
    </div>
  );
}

/**
 * Filling a question's options from a list kept elsewhere.
 *
 * Shown only when there is a pool to copy: an organizer who keeps none should
 * not be offered a control that can do nothing, and the ones who do keep them
 * are the ones typing the same twelve names into every question.
 *
 * It appends, and it says how many it added afterwards, because "copy" with no
 * answer leaves you scrolling to find out whether it worked.
 */
function CopyFromPool({ type, questionId, onCopied }: {
  type: QuestionType; questionId: string; onCopied: () => Promise<void> | void;
}) {
  const [pools, setPools] = useState<OptionPool[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api.myOptionPools()
      .then((p) => { if (live) setPools(p); })
      .catch(() => { if (live) setPools([]); });
    return () => { live = false; };
  }, []);

  if (!pools || pools.length === 0) return null;

  const copy = async () => {
    const pool = chosen || pools[0]!.id;
    setBusy(true); setError(''); setSaid('');
    try {
      const added = await api.copyPoolIntoQuestion(pool, type, questionId);
      setSaid(added === 0
        ? 'That pool is empty.'
        : `Added ${added} option${added === 1 ? '' : 's'}.`);
      await onCopied();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not copy that pool.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 14 }}>
      {error ? <Banner kind="error">{error}</Banner> : null}
      <div className="row">
        <select className="grow" name="pool_choice" value={chosen}
                onChange={(e) => { setChosen(e.target.value); setSaid(''); }}>
          {pools.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button className="ghost small" disabled={busy} onClick={() => void copy()}>
          {busy ? 'Copying…' : 'Copy from pool'}
        </button>
      </div>
      {said ? <p className="faint" style={{ marginTop: 6 }}>{said}</p> : null}
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

      <CopyFromPool type={type} questionId={questionId} onCopied={load} />

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

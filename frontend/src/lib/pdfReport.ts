/**
 * The results as a PDF.
 *
 * Built in the browser from exactly what the results page was handed, so the
 * report never shows more than the page does: a public X-of-N result has no
 * counts here either. jsPDF is loaded only when a report is asked for, so the
 * page itself carries none of its weight.
 *
 * The built-in Helvetica covers Latin-1, which is every name in a South
 * African member list we have seen; anything outside it prints as a '?'.
 */
import type { jsPDF as JsPDF } from 'jspdf';
import type {
  BallotResults, HighestXTally, OutrightTally, QuestionResult, RecursionTally, YesNoTally,
} from './types';
import { thresholdRule } from './rules';
import { roundNote } from '../components/RecursionResult';

const PAGE_W = 210;
const MARGIN = 18;
const WIDTH = PAGE_W - MARGIN * 2;
const BOTTOM = 297 - 18;

const INK = '#1f2328';
const SOFT = '#6b6f76';
const ACCENT = '#1d5c6b';
const WON = '#2f7a4b';
const LOST = '#b9b4a9';
const RULE = '#e4e0d6';

/** Builds the report and hands it to the browser as a download. */
export async function downloadResultsPdf(data: BallotResults, logoUrl: string | null): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const w = new Writer(doc);

  // ------------------------------------------------------------ the heading
  const logo = logoUrl ? await imageData(logoUrl) : null;
  if (logo) {
    try { doc.addImage(logo.data, logo.format, MARGIN, w.y, 16, 16); } catch { /* an unreadable mark is left out */ }
  }
  const x0 = logo ? MARGIN + 20 : MARGIN;
  doc.setTextColor(SOFT); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('RESULTS', x0, w.y + 4);
  doc.setTextColor(INK); doc.setFontSize(18);
  const title = doc.splitTextToSize(data.ballot.title, WIDTH - (x0 - MARGIN));
  doc.text(title, x0, w.y + 11);
  w.y += 11 + (title.length - 1) * 7;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(SOFT);
  doc.text(
    `${data.turnout.used} of ${data.turnout.issued} PINs used  ·  counted ${stamp(data.updated)}  ·  report made ${stamp(new Date().toISOString())}`,
    x0, w.y + 6);
  w.y = Math.max(w.y + 10, logo ? MARGIN + 20 : 0);
  if (data.ballot.description) w.paragraph(data.ballot.description, 10, SOFT);
  w.rule();

  if (data.withheld > 0) {
    w.paragraph(`${data.withheld} question${data.withheld === 1 ? ' is' : 's are'} still open and not in this report. Each one publishes when the chair closes it.`, 9, SOFT);
  }
  if (data.questions.length === 0) {
    w.paragraph(data.withheld > 0 ? 'Nothing has been published yet.' : 'This ballot has no questions.', 11, INK);
  }

  // ---------------------------------------------------------- the questions
  data.questions.forEach((q, i) => {
    if (i > 0) w.rule();
    question(w, q);
  });

  // --------------------------------------------------------- page numbers
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(SOFT);
    doc.text(data.ballot.title, MARGIN, 297 - 10, { maxWidth: WIDTH - 30 });
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, 297 - 10, { align: 'right' });
  }

  doc.save(`${fileName(data.ballot.title)}-results-${new Date().toISOString().slice(0, 10)}.pdf`);
}

/* ------------------------------------------------------------ one question */

function question(w: Writer, q: QuestionResult) {
  w.need(24);
  w.heading(q.prompt);
  if (q.description) w.paragraph(q.description, 9, SOFT);
  if (q.type === 'yes_no') yesNo(w, q.tally);
  if (q.type === 'highest_outright') outright(w, q.tally);
  if (q.type === 'highest_x') highestX(w, q.tally);
  if (q.type === 'recursion_filter') race(w, q.tally);
}

function yesNo(w: Writer, t: YesNoTally) {
  const outcome = t.carried === null ? 'No votes yet' : t.carried ? 'Carried' : 'Defeated';
  w.outcome(outcome, t.carried === null ? SOFT : t.carried ? WON : '#96312d',
    `needs ${thresholdRule(t.threshold, t.threshold_strict)}`);
  const of = t.decisive || 1;
  w.bar(t.labels.yes, t.yes, t.yes / of, t.carried === true);
  w.bar(t.labels.no, t.no, t.no / of, t.carried === false);
  if (t.abstain > 0) w.bar(t.labels.abstain, t.abstain, null, false, true);
  w.note(`${t.voters} voted · ${t.decisive} decisive${t.abstain > 0 ? ` · ${t.abstain} abstained` : ''}`);
}

function outright(w: Writer, t: OutrightTally) {
  const winner = t.options.find((o) => o.id === t.winner);
  w.outcome(
    t.total === 0 ? 'No votes yet' : t.tied ? 'Tied' : winner ? winner.label : 'No outright winner',
    winner && !t.tied ? WON : SOFT,
    t.require_majority && !t.majority_reached && t.total > 0 ? 'no option took more than half' : '');
  for (const o of t.options) w.bar(o.label, o.votes ?? 0, o.share ?? 0, o.id === t.winner);
  w.note(`${t.voters} voted${t.abstain > 0 ? ` · ${t.abstain} abstained` : ''}`);
}

function highestX(w: Writer, t: HighestXTally) {
  const elected = t.options.filter((o) => o.elected);
  w.outcome(elected.length ? elected.map((o) => o.label).join(' · ') : 'No result yet',
    elected.length ? WON : SOFT, `top ${t.winner_count} elected`);
  if (t.redacted) {
    w.note('Listed in no particular order. Counts are not published for this kind of question.');
  } else {
    for (const o of t.options) w.bar(o.label, o.votes ?? 0, o.share ?? 0, Boolean(o.elected));
    w.note(`${t.voters} voted · ${t.total ?? 0} selections · share is of voters, not of selections`);
  }
  if (t.tied_at_cut) w.note('The vote is tied at the cut-off. The last seat is not decided by this count.');
}

function race(w: Writer, t: RecursionTally) {
  const seats = t.seats ?? 1;
  const elected = t.elected ?? [];
  if (seats > 1) {
    w.outcome(t.phase === 'decided' ? 'Elected' : `In progress: round ${t.current_round}`,
      t.phase === 'decided' ? WON : SOFT, `${elected.length} of ${seats} seats filled`);
    elected.forEach((e, i) => w.line(`${i + 1}.  ${e.label}${e.round !== null ? `   (round ${e.round})` : ''}`));
  } else {
    w.outcome(
      t.winner ? t.winner.label : t.phase === 'decided' ? 'Ended with no winner' : `In progress: ${t.phase === 'nominating' ? 'nominations' : `round ${t.current_round}`}`,
      t.winner ? WON : SOFT, '');
  }

  // every round, oldest first: a report has no folds to open
  const rounds = t.rounds.filter((r) => r.settled || r.tally.opened || r.tally.voters > 0);
  for (const r of rounds) {
    w.need(18);
    w.subheading(r.kind === 'nomination' ? 'Nominations'
      : `Round ${r.round}${seats > 1 && r.seats_open !== undefined ? ` · ${r.seats_open} seat${r.seats_open === 1 ? '' : 's'} open` : ''}`);
    const named = r.kind === 'nomination' ? r.tally.options.filter((o) => o.votes > 0) : r.tally.options;
    for (const o of named) {
      const out = r.settled && (r.dropped ?? []).some((d) => d.id === o.id);
      const won = (r.settled && (r.elected ?? []).some((d) => d.id === o.id)) || o.id === t.winner?.id && r.round === t.current_round;
      w.bar(`${o.label}${out ? '  (out)' : won ? '  (elected)' : ''}`, o.votes,
        r.tally.ballots > 0 ? o.share : null, won, out);
    }
    const unnamed = r.tally.options.length - named.length;
    if (unnamed > 0) w.note(`${unnamed} other${unnamed === 1 ? '' : 's'} in the pool with no nominations.`);
    w.note(roundNote(r, t.nominate_threshold));
  }
}

/* ------------------------------------------------------------------ layout */

class Writer {
  y = MARGIN;
  constructor(private doc: JsPDF) {}

  /** Starts a new page if fewer than `mm` are left on this one. */
  need(mm: number) {
    if (this.y + mm > BOTTOM) { this.doc.addPage(); this.y = MARGIN; }
  }

  heading(text: string) {
    const d = this.doc;
    d.setFont('helvetica', 'bold'); d.setFontSize(13); d.setTextColor(INK);
    const lines = d.splitTextToSize(text, WIDTH);
    this.need(lines.length * 6 + 4);
    d.text(lines, MARGIN, this.y + 5);
    this.y += lines.length * 6 + 2;
  }

  subheading(text: string) {
    const d = this.doc;
    d.setFont('helvetica', 'bold'); d.setFontSize(10); d.setTextColor(INK);
    this.need(8);
    d.text(text, MARGIN, this.y + 5);
    this.y += 7;
  }

  paragraph(text: string, size: number, color: string) {
    const d = this.doc;
    d.setFont('helvetica', 'normal'); d.setFontSize(size); d.setTextColor(color);
    const lines = d.splitTextToSize(text, WIDTH);
    const h = lines.length * size * 0.42 + 2;
    this.need(h);
    d.text(lines, MARGIN, this.y + size * 0.4);
    this.y += h;
  }

  line(text: string) { this.paragraph(text, 10, INK); }
  note(text: string) { if (text) this.paragraph(text, 8.5, SOFT); }

  outcome(text: string, color: string, aside: string) {
    const d = this.doc;
    this.need(9);
    d.setFont('helvetica', 'bold'); d.setFontSize(11); d.setTextColor(color);
    const shown = d.splitTextToSize(text, WIDTH)[0] as string;
    d.text(shown, MARGIN, this.y + 5);
    if (aside) {
      const wText = d.getTextWidth(shown);
      d.setFont('helvetica', 'normal'); d.setFontSize(9); d.setTextColor(SOFT);
      d.text(`  ·  ${aside}`, MARGIN + wText, this.y + 5);
    }
    this.y += 9;
  }

  /** One option: its name, its count and share, and a bar. */
  bar(label: string, votes: number, share: number | null, won: boolean, lost = false) {
    const d = this.doc;
    this.need(7);
    d.setFont('helvetica', won ? 'bold' : 'normal'); d.setFontSize(9.5); d.setTextColor(INK);
    const name = d.splitTextToSize(label, 92)[0] as string;
    d.text(name, MARGIN, this.y + 4);
    d.setFont('helvetica', 'normal'); d.setTextColor(SOFT);
    d.text(share === null ? `${votes}` : `${votes} · ${(share * 100).toFixed(1)}%`, MARGIN + 128, this.y + 4, { align: 'right' });
    const bx = MARGIN + 132, bw = WIDTH - 132;
    d.setFillColor(RULE); d.roundedRect(bx, this.y + 1.6, bw, 2.6, 1.3, 1.3, 'F');
    if (share !== null && share > 0) {
      d.setFillColor(won ? WON : lost ? LOST : ACCENT);
      d.roundedRect(bx, this.y + 1.6, Math.max(bw * Math.min(share, 1), 1.5), 2.6, 1.3, 1.3, 'F');
    }
    this.y += 6.2;
  }

  rule() {
    this.need(8);
    this.doc.setDrawColor(RULE); this.doc.setLineWidth(0.3);
    this.doc.line(MARGIN, this.y + 3, PAGE_W - MARGIN, this.y + 3);
    this.y += 7;
  }
}

/* ------------------------------------------------------------------- bits */

function stamp(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ') + ' UTC';
}

function fileName(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'ballot';
}

/** A logo as data jsPDF can draw; null for anything it cannot (an SVG, a failed fetch). */
async function imageData(url: string): Promise<{ data: string; format: 'PNG' | 'JPEG' } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const format = blob.type.includes('png') ? 'PNG' : blob.type.includes('jpeg') || blob.type.includes('jpg') ? 'JPEG' : null;
    if (!format) return null;
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    return { data, format };
  } catch {
    return null;
  }
}

/**
 * Installs supabase/templates/*.html as the project's auth emails.
 *
 * Through the Management API rather than `supabase config push`, and that is
 * the whole point of this file. `config push` sends the entire auth config:
 * anything config.toml does not mention is sent as its default, which would
 * overwrite the Google provider, the redirect URLs and the site URL this
 * project actually has. A PATCH here names only the mailer fields, so nothing
 * else can be touched by it.
 *
 * Needs a personal access token, from
 * https://supabase.com/dashboard/account/tokens -- either in
 * SUPABASE_ACCESS_TOKEN or wherever `supabase login` left it.
 *
 *   bun run scripts/push-email-templates.ts            # says what would change
 *   bun run scripts/push-email-templates.ts --apply    # changes it
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const API = 'https://api.supabase.com/v1';

/** Every template, with the subject line it is sent under. */
const TEMPLATES: Array<{ key: string; file: string; subject: string }> = [
  { key: 'confirmation',    file: 'confirmation.html',    subject: 'Confirm your email' },
  { key: 'recovery',        file: 'recovery.html',        subject: 'Set a new password' },
  { key: 'magic_link',      file: 'magic_link.html',      subject: 'Your sign-in link' },
  { key: 'invite',          file: 'invite.html',          subject: 'You have been invited to VotingStation' },
  { key: 'email_change',    file: 'email_change.html',    subject: 'Confirm your new email address' },
  { key: 'reauthentication', file: 'reauthentication.html', subject: 'Your confirmation code' },
];

function token(): string {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN;
  if (fromEnv) return fromEnv;

  // where the CLI leaves it when it is not using a system keyring
  const stored = join(homedir(), '.supabase', 'access-token');
  if (existsSync(stored)) {
    const t = readFileSync(stored, 'utf8').trim();
    if (t) return t;
  }

  throw new Error(
    'No access token. Run `supabase login`, or set SUPABASE_ACCESS_TOKEN from\n'
    + 'https://supabase.com/dashboard/account/tokens',
  );
}

/** The project this repository is linked to. */
function projectRef(): string {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const found = /^\s*project_id\s*=\s*"([^"]+)"/m.exec(toml);
  if (!found) throw new Error('No project_id in supabase/config.toml');
  return found[1]!;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const ref = projectRef();
  const auth = { Authorization: `Bearer ${token()}` };

  const current = await fetch(`${API}/projects/${ref}/config/auth`, { headers: auth });
  if (!current.ok) {
    throw new Error(`Could not read the auth config: ${current.status} ${await current.text()}`);
  }
  const live = (await current.json()) as Record<string, unknown>;

  const patch: Record<string, string> = {};
  for (const t of TEMPLATES) {
    const html = readFileSync(join(ROOT, 'supabase', 'templates', t.file), 'utf8');
    const contentKey = `mailer_templates_${t.key}_content`;
    const subjectKey = `mailer_subjects_${t.key}`;

    const sameContent = live[contentKey] === html;
    const sameSubject = live[subjectKey] === t.subject;
    console.log(
      `${t.file.padEnd(24)} ${sameContent ? 'content unchanged' : 'content DIFFERS'}`
      + `  ${sameSubject ? 'subject unchanged' : 'subject DIFFERS'}`,
    );

    if (!sameContent) patch[contentKey] = html;
    if (!sameSubject) patch[subjectKey] = t.subject;
  }

  const fields = Object.keys(patch);
  if (fields.length === 0) {
    console.log('\nNothing to do: the project already has these.');
    return;
  }

  if (!apply) {
    console.log(`\n${fields.length} field(s) would change. Pass --apply to send them.`);
    return;
  }

  const sent = await fetch(`${API}/projects/${ref}/config/auth`, {
    method: 'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!sent.ok) throw new Error(`PATCH refused: ${sent.status} ${await sent.text()}`);

  // Read it back rather than trust the 200: this is the only way to know the
  // project holds what is in the repository.
  const reread = await fetch(`${API}/projects/${ref}/config/auth`, { headers: auth });
  const after = (await reread.json()) as Record<string, unknown>;

  let wrong = 0;
  for (const t of TEMPLATES) {
    const html = readFileSync(join(ROOT, 'supabase', 'templates', t.file), 'utf8');
    const ok = after[`mailer_templates_${t.key}_content`] === html
            && after[`mailer_subjects_${t.key}`] === t.subject;
    if (!ok) wrong++;
    console.log(`${ok ? 'installed' : 'MISMATCH '}  ${t.file}`);
  }
  if (wrong > 0) throw new Error(`${wrong} template(s) did not land`);
  console.log('\nAll six match the repository.');
}

await main();

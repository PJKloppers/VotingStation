# The email templates

One shell, six letters. Each file is a whole HTML document because that is what
Supabase sends -- there is no layout to inherit from, so the shell is repeated
rather than shared, and a change to the frame is a change to six files.

They are written the way email has to be written, which is not how the app is
written:

- Tables for layout. Flexbox and grid do not exist in Outlook, which renders
  through Word.
- Every style inline on the element it applies to. Gmail strips `<style>` from
  the document it displays, so anything that has to survive cannot live there.
  The one `<style>` block each file keeps holds only the dark-scheme overrides,
  which are a bonus where they work and nothing where they do not.
- No web fonts. Georgia and the system sans are on the machines that matter.
- The mark is an absolute https URL on the app's own domain, sized in the
  attribute as well as the style, because a client that blocks images still
  lays the box out.

The palette is the app's: paper #f8f6f1, ink #16181d, soft ink #565b66,
rule #ddd8cd, accent #1e5f74.

## The variables

Supabase substitutes these; they are not ours to rename.

- `{{ .ConfirmationURL }}` -- the link. Every template here leads with it.
- `{{ .Token }}` -- the six-digit code, for a reader who would rather type.
- `{{ .Email }}` / `{{ .NewEmail }}` -- only in the email-change letter.
- `{{ .SiteURL }}` -- the deploy root.

## Installing them

Paste each file into the dashboard, Authentication -> Emails, against the
template its name matches.

The `[auth.email.template.*]` entries in `supabase/config.toml` describe the
same thing for the CLI, but `supabase config push` sends the *whole* auth
config, not just this part -- it would overwrite the providers, the redirect
URLs and the rest with whatever config.toml happens to say. Do not push until
config.toml mirrors the project as it actually stands.

# Security

## Reporting a problem

Email <claude@charlie.cx>. Please don't open a public issue for a security
problem before it's fixed.

## How Lightmorphic Text is put together

- The renderer runs sandboxed with context isolation on and Node integration
  off. It reaches the filesystem and the system only through a fixed list of
  calls in `src/preload.js`.
- No command is ever run through a shell. Every process call passes its
  arguments as a list, so nothing read from a config file, a release listing or
  a form field can turn into a shell command.
- Writes are confined to the Espanso match directory. Paths coming from the
  renderer are resolved and checked against it, so a crafted relative path
  cannot escape.
- The only network requests are to `api.github.com` and
  `github.com`: Espanso's official releases, and Lightmorphic Text's own update check.
  Nothing downloads without the user asking for it.
- The one privileged action — adding the user to the `input` group on Wayland —
  goes through `pkexec`, so the desktop's own prompt asks for consent. Lightmorphic Text
  never handles a password.
- Every match file write goes to a temporary file and is renamed into place, so
  an interrupted save cannot leave a half-written file behind, and the previous
  contents are copied to a backup first.

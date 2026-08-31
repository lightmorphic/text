# Changelog

All notable changes to Lightmorphic Text are recorded here.
This project follows [semantic versioning](https://semver.org).

## [1.0.1] - 2026-08-31

- On Wayland, the keyboard layout your desktop uses is now written into
  Espanso's configuration automatically. Without it Espanso assumed a US
  layout, so on a UK keyboard triggers using keys like # or @ never fired.

## [1.0.0] - 2026-08-30

First release.

- Searchable list of every Espanso trigger and replacement, across all match
  files in the config directory.
- Add, edit and delete snippets through a form, with whole-words-only and
  case-matching options.
- Comment-preserving writes: only the values that changed are rewritten, and
  every save keeps a backup.
- Snippets using variables, forms, scripts or regular expressions are listed
  and shown as they appear in the file, but never rewritten.
- Espanso is restarted after each save, so changes take effect immediately.
- Guided first run: detects the display server and installs Espanso — and,
  where the system lacks them, the wl-clipboard tools — from official
  releases, without a package manager. Works on immutable systems such as
  openSUSE Aeon, Fedora Silverblue and Bazzite.
- Wayland support, including the one-off input-group step through the
  desktop's own password prompt (pkexec or run0).
- An off switch for Espanso, a crash-safe service with plain-English
  diagnostics, and an update dot that checks when clicked.
- Light and dark, following the desktop.

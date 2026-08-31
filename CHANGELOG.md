# Changelog

All notable changes to Lightmorphic Text are recorded here.
This project follows [semantic versioning](https://semver.org).

## [1.0.8] - 2026-08-31

- The tray icon has its own artwork now: the glyphs on a navy disc with a
  yellow ring around the edge, so it stands out against dark and light
  panels instead of blending in.

## [1.0.7] - 2026-08-31

- The update widget shows just the version number and the dot; the app
  name next to it is gone. The version still links to the website.

## [1.0.6] - 2026-08-31

- The tray icon now really appears on GNOME Wayland. Electron 43.3 broke
  StatusNotifier tray icons there (electron/electron#52674) and the 43.4.1
  fix does not hold on GNOME 50.4, so Electron is pinned to 43.2.0 — the
  last version whose tray registration works — verified against a live
  GNOME tray. Do not bump Electron past 43.2.0 until the upstream fix is
  confirmed on GNOME Wayland.

## [1.0.5] - 2026-08-31

- The tray icon now actually appears on GNOME with the AppIndicator
  extension: the icon is served from a real file (tray icons can't be read
  from inside the app bundle), and the tray check uses a tool every system
  has. The icon is always created; only close-to-tray still depends on the
  desktop really having a tray.

## [1.0.4] - 2026-08-31

- The update dot is now a plain coloured circle in every state, as the
  widget spec says — the little download and restart glyphs inside it are
  gone; the tooltip carries the words.

## [1.0.3] - 2026-08-31

- A tray icon, where the desktop has a tray: closing the window now keeps
  Lightmorphic Text running quietly in the background (updates included),
  with Open and Quit in the tray menu and a one-time notification saying so.
  KDE has a tray out of the box; GNOME needs its AppIndicator extension. On
  desktops with no tray, closing the window still quits, so the app can
  never become unreachable.

## [1.0.2] - 2026-08-31

- The update dot now matches the Lightmorphic update-widget spec exactly:
  blue when a downloaded update is ready to install (it was green), a
  slightly larger dot, the spec's tooltip wording, and a progress line
  that stays visible in the light theme.

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

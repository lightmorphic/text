'use strict';

// Launches the real app against a throwaway Espanso config, drives it, and
// captures the screenshots used in the README, on the website and in the
// AppStream metadata. Doubles as an end-to-end smoke test: if the setup
// screen or the editor stops working, this fails rather than producing a
// wrong-looking picture.
//
// Run with: node scripts/screenshots.js

const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'shots');

const DEMO = `# Everyday snippets.
# Textmorph keeps these comments exactly where you put them.

matches:
  # Contact details
  - trigger: ":sig"
    replace: |-
      Charlie Lark
      Lightmorphic
      hello@lightmorphic.co.uk

  - triggers: [":em", ":mail"]
    replace: "hello@lightmorphic.co.uk"
    word: true

  - trigger: ":tel"
    replace: "01234 567890"

  # Writing shortcuts
  - trigger: ":addr"
    replace: |-
      Lightmorphic
      12 Example Street
      Manchester M1 1AA

  - trigger: ":brb"
    replace: "be right back"
    word: true

  - trigger: ":ty"
    replace: "Thanks very much — much appreciated."

  # Uses a date variable, so Textmorph shows it but leaves it alone
  - trigger: ":today"
    replace: "Today is {{now}}"
    vars:
      - name: now
        type: date
        params:
          format: "%A %-d %B %Y"
`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'textmorph-shots-'));
  const matchDir = path.join(sandbox, 'config', 'espanso', 'match');
  fs.mkdirSync(matchDir, { recursive: true });
  fs.writeFileSync(path.join(matchDir, 'base.yml'), DEMO, 'utf8');

  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(sandbox, 'config'),
    XDG_DATA_HOME: path.join(sandbox, 'data'),
    // Pin the session so the shots are reproducible whichever desktop this
    // is run from; Wayland is the one with the extra setup step to show.
    XDG_SESSION_TYPE: 'wayland',
    WAYLAND_DISPLAY: 'wayland-0',
  };

  const app = await electron.launch({ args: [ROOT], env });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1240, height: 840 });

  // --- the guided first run -------------------------------------------------
  await page.waitForSelector('#screen-setup:not([hidden])');
  await page.waitForFunction(() => document.getElementById('setup-facts').children.length > 0);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'setup.png') });

  // --- the main screen ------------------------------------------------------
  await page.click('#setup-secondary');
  await page.waitForSelector('#screen-main:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('.entry').length >= 7);

  await page.click('.entry[data-id="base.yml#0"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'main.png') });

  // --- searching ------------------------------------------------------------
  await page.fill('#search', 'thanks');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'search.png') });
  await page.fill('#search', '');

  // --- a snippet Textmorph will not rewrite --------------------------------
  await page.click('.entry[data-id="base.yml#6"]');
  await page.waitForSelector('#field-raw-wrap:not([hidden])');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'advanced.png') });

  // --- the same screen in dark mode ---------------------------------------
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('.entry[data-id="base.yml#0"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'main-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // Prove the round trip really works before calling these shots good.
  await page.click('#btn-new');
  await page.fill('#field-trigger', ':demo');
  await page.fill('#field-replace', 'Written by the screenshot run.');
  await page.click('#btn-save');
  await page.waitForSelector('#edit-success:not([hidden])');
  const written = fs.readFileSync(path.join(matchDir, 'base.yml'), 'utf8');
  if (!written.includes('trigger: ":demo"')) throw new Error('the new snippet was not written');
  if (!written.includes('# Contact details')) throw new Error('comments were lost on save');

  await app.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log(`screenshots written to ${path.relative(ROOT, OUT)}/`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Headless click-through of the strip above the message box: it appears when
// the working tree has something to commit, names the branch and the count,
// carries the two agent buttons, and goes away when the tree is clean again.
//
//   node scripts/live-check.mjs setup /tmp/vcs-scratch          # once
//   VCS_E2E_THREAD=thr_x VCS_E2E_PROJECT=proj_x node scripts/live-check-m7.mjs /tmp/vcs-scratch
//
// It never clicks either button: on this banner a click needs a dirty tree by
// definition, so it would wake the thread's agent with something to commit.
// That one is scenario 6 in docs/VERIFY.md, by hand.
//
// See docs/VERIFY.md. Needs system Chromium and puppeteer-core in node_modules.
import { browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const REPO = process.argv[2];
if (!REPO) {
  console.error("usage: live-check-m7.mjs <repo path>");
  process.exit(2);
}
const H = await browserHelpers();
const { step, summary } = recorder();
const TS = Date.now().toString(36);
const BANNER = '[data-testid="vcs-composer-banner"]';

sh(`git -C ${REPO} switch -q main`);
sh(`git -C ${REPO} reset -q --hard origin/main`);
sh(`git -C ${REPO} clean -fdq`);

const a = await H.launch("m7");
const page = a.page;

const bannerText = async () => (await page.$eval(BANNER, (e) => e.innerText).catch(() => "")).replace(/\n+/g, " | ");
const waitBanner = async (re, ms = 20_000) => {
  const t0 = Date.now();
  let last = "";
  while (Date.now() - t0 < ms) {
    last = await bannerText();
    if (re.test(last)) return last;
    await sleep(400);
  }
  return `TIMEOUT last="${last.slice(0, 300)}"`;
};
const gone = async (ms = 20_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await page.$(BANNER)) === null) return true;
    await sleep(400);
  }
  return false;
};

try {
  // M7-0 a clean tree says nothing at all.
  await sleep(2000);
  step("M7-0 no banner over a clean tree", (await page.$(BANNER)) === null, await bannerText());

  // M7-1 it arrives on its own when the tree changes under it: the watch the
  // first overview registered is what pushes this, no click involved.
  sh(`cd ${REPO} && echo m7-a >> a.txt && echo m7-new-${TS} > new-${TS}.txt`);
  const dirty = await waitBanner(/2 to commit/);
  step("M7-1 the banner appears by itself with the branch and the count", /main/.test(dirty) && /2 to commit/.test(dirty), dirty.slice(0, 200));

  // M7-2 the count is files, untracked included, and the hover breaks it down.
  await H.shot(page, "m7-1-banner");
  const detail = await page
    .$eval(`${BANNER} [data-testid="vcs-composer-count"]`, (e) => e.getAttribute("title"))
    .catch(() => "");
  step("M7-2 the hover breaks the count down", /1 unstaged, 1 untracked/.test(detail), detail);

  // M7-3 the two buttons, their labels and what they promise. Not clicked.
  const buttons = await page.$$eval(`${BANNER} button`, (els) =>
    els.map((e) => ({ text: e.innerText.trim(), disabled: e.disabled, label: e.getAttribute("aria-label") ?? "" })),
  );
  step(
    "M7-3 both agent buttons, enabled, saying what they send",
    buttons.length === 2 &&
      buttons[0].text === "Agent Commit" &&
      buttons[1].text === "Agent Commit & Push" &&
      buttons.every((b) => !b.disabled) &&
      buttons.every((b) => /Runs no git here\.$/.test(b.label)),
    JSON.stringify(buttons).slice(0, 300),
  );

  // M7-4 and it gets out of the way again.
  sh(`git -C ${REPO} checkout -- a.txt && rm -f ${REPO}/new-${TS}.txt`);
  step("M7-4 the banner goes when the tree is clean again", await gone(), await bannerText());
} finally {
  sh(`git -C ${REPO} checkout -q -- . && rm -f ${REPO}/new-${TS}.txt`);
  await a.browser.close();
}

process.exit(summary() ? 0 : 1);

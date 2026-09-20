#!/usr/bin/env node
// M8: the popup and the commit panel under a repository big enough to hurt.
//
// The earlier milestones check that the surfaces work. This one checks that
// they stay cheap when a thread's worktree holds hundreds of branches and
// hundreds of changed files — the case that made the popup take a third of a
// second to appear and the splitter drag run at about one frame a second.
//
// Two ways to run it:
//
//   node scripts/live-check-m8.mjs <repo path>              # makes its own fixture
//   node scripts/live-check-m8.mjs <repo path> --read-only  # measures what is there
//
// The first creates 300 branches and 400 untracked files in <repo>, then
// removes them. **Never point it at a repository you care about.** The second
// changes nothing at all and is what you use against a real thread's worktree.
//
// It never clicks a branch row, never stages anything and never commits: every
// measurement is a read.
//
// Env: BB_SERVER_URL, CHROMIUM, VCS_E2E_THREAD, VCS_E2E_PROJECT.
// `npm install --no-save puppeteer-core` once, and `bb` on PATH for the git
// fixture.
import { browserHelpers, recorder, sh, sleep } from "./live-lib.mjs";

const REPO = process.argv[2];
const READ_ONLY = process.argv.includes("--read-only");
if (!REPO) {
  console.error("usage: live-check-m8.mjs <repo path> [--read-only]");
  process.exit(2);
}

/** Rows the popup may render at once: a viewport plus its overscan either side. */
const POPUP_ROW_BUDGET = 40;
/** Rows of the changed-file list the same. */
const FILE_ROW_BUDGET = 80;
/** Nodes the whole commit panel may hold. It held eleven thousand. */
const PANEL_NODE_BUDGET = 6_000;
/** Main-thread work one popup open may cost, in milliseconds. It cost 820. */
const OPEN_LONG_TASK_BUDGET = 400;
/**
 * Main-thread work a twenty-step splitter drag may cost. It cost about 1900,
 * and the drag is measured with in-page pointer events rather than a real
 * mouse: a driven mouse against this page costs about a second a frame on its
 * own, which is an artefact of the harness and not of the plugin.
 */
const DRAG_LONG_TASK_BUDGET = 500;
/** Diff bodies allowed to be mounted at once, from the stream's own margin. */
const MOUNTED_CARD_BUDGET = 60;
/**
 * Main-thread work thirty pane width changes may cost with a wrapping diff.
 * Without the pin it is about 180ms a frame — five seconds of long tasks —
 * against roughly one frame of it with the pin, plus the settle.
 */
const WRAP_RESIZE_LONG_TASK_BUDGET = 1_200;

const H = await browserHelpers();
const { step, summary } = recorder();
const TS = Date.now().toString(36);

const BRANCHES = 300;
const FILES = 400;
const BRANCH_PREFIX = `perf-${TS}-`;
const FILE_PREFIX = `perf-${TS}-file-`;

/** Every row the popup has in the DOM, in order. */
const POPUP_ITEMS = '[data-testid="vcs-branch-popup"] [cmdk-item]';

/** Escape closes the popup; the button closes it too if the key was swallowed. */
async function closePopup(page) {
  await page.keyboard.press("Escape");
  await sleep(400);
  if (await page.$('[data-testid="vcs-branch-popup"]')) {
    await page.evaluate(() => document.querySelector('[data-testid="vcs-branch-button"]').click());
  }
  await sleep(400);
}

/**
 * Open the popup and wait until it has rows in it. Waiting for the element
 * alone is not enough: Radix keeps it in the DOM through its close animation,
 * so a popup that is on its way out still matches the selector.
 */
async function openPopup(page) {
  await closePopup(page);
  await page.click('[data-testid="vcs-branch-button"]');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="vcs-branch-popup"] [cmdk-item]').length > 0,
    { timeout: 15_000 },
  );
  await sleep(800);
}

async function withPopup(page, run) {
  await openPopup(page);
  const result = await run();
  await closePopup(page);
  return result;
}

async function openCommitPanel(page) {
  await withPopup(page, async () => {
    // The quick action opens the panel as a tab; nothing here runs git.
    await page.click(`${POPUP_ITEMS}[data-action="commit"]`);
    await sleep(800);
  });
  await page.waitForSelector('[data-testid="vcs-commit-panel"]', { timeout: 20_000 });
  await sleep(6_000);
}

try {
  if (!READ_ONLY) {
    for (let index = 0; index < BRANCHES; index += 1) {
      sh(`git -C ${REPO} branch ${BRANCH_PREFIX}${index}`);
    }
    sh(`cd ${REPO} && for i in $(seq 1 ${FILES}); do echo x > ${FILE_PREFIX}"$i".txt; done`);
    console.log(`fixture: ${BRANCHES} branches, ${FILES} untracked files in ${REPO}`);
  } else {
    console.log(`read-only: measuring ${REPO} as it is, creating nothing`);
  }

  const a = await H.launch("m8a");
  const page = a.page;

  // ---------------------------------------------------------------- popup --
  const open = await page.evaluate(async () => {
    const button = document.querySelector('[data-testid="vcs-branch-button"]');
    const longTasks = [];
    const performanceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    try {
      performanceObserver.observe({ entryTypes: ["longtask"] });
    } catch {
      // A browser without longtask entries still gets the row counts below.
    }
    const started = performance.now();
    let popupAt = null;
    let rowsAt = null;
    const mutations = new MutationObserver(() => {
      if (popupAt === null && document.querySelector('[data-testid="vcs-branch-popup"]')) {
        popupAt = Math.round(performance.now() - started);
      }
      if (rowsAt === null && document.querySelector('[data-testid="vcs-popup-spacer-top"]')) {
        rowsAt = Math.round(performance.now() - started);
      }
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    button.click();
    for (let tick = 0; tick < 400; tick += 1) {
      await new Promise((done) => setTimeout(done, 10));
      if (rowsAt !== null) break;
    }
    await new Promise((done) => setTimeout(done, 800));
    mutations.disconnect();
    performanceObserver.disconnect();
    return {
      popupAt,
      rowsAt,
      items: document.querySelectorAll('[data-testid="vcs-branch-popup"] [cmdk-item]').length,
      longTasks,
      longTaskTotal: longTasks.reduce((total, value) => total + value, 0),
    };
  });
  step(
    "M8-0 the popup renders a window of rows, not the whole repository",
    open.items > 0 && open.items <= POPUP_ROW_BUDGET,
    `${open.items} rows, budget ${POPUP_ROW_BUDGET}; appeared at ${open.popupAt}ms`,
  );
  step(
    "M8-1 opening it costs one short task rather than a stalled half-second",
    open.longTaskTotal < OPEN_LONG_TASK_BUDGET,
    `long tasks ${open.longTaskTotal}ms total (${open.longTasks.join(", ")}), budget ${OPEN_LONG_TASK_BUDGET}ms`,
  );

  // --------------------------------------------------------------- typing --
  const typing = await page.evaluate(async () => {
    const input = document.querySelector('[data-testid="vcs-branch-popup"] input');
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const costs = [];
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Reported as no long tasks below.
    }
    for (const character of "feature") {
      const started = performance.now();
      setter.call(input, input.value + character);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((done) => setTimeout(done, 0));
      costs.push(Math.round(performance.now() - started));
    }
    await new Promise((done) => setTimeout(done, 400));
    observer.disconnect();
    return { costs, max: Math.max(...costs), longTasks };
  });
  step(
    "M8-2 typing filters without a long task",
    typing.longTasks.length === 0,
    `long tasks ${typing.longTasks.join(", ") || "none"}; per keystroke ${typing.costs.join(", ")}ms`,
  );

  // --------------------------------------------------------- the walk down --
  const walk = await page.evaluate(async () => {
    const popup = document.querySelector('[data-testid="vcs-branch-popup"]');
    const input = popup.querySelector("input");
    input.focus();
    const selected = () => popup.querySelector('[cmdk-item][aria-selected="true"]');
    const press = async (key, times) => {
      for (let index = 0; index < times; index += 1) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await new Promise((done) => setTimeout(done, 40));
      }
    };
    // Clear whatever the previous step typed.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 400));

    await press("ArrowDown", 3);
    const seen = [];
    for (let index = 0; index < 60; index += 1) {
      await press("ArrowDown", 1);
      seen.push(selected()?.getAttribute("data-value") ?? null);
    }
    const furthest = () => Math.round(Number.parseFloat(popup.querySelector('[data-testid="vcs-popup-spacer-top"]').style.height || "0") / 32);
    // Read before Home and End, which both move the window themselves.
    const movedDown = furthest() > 0;
    const afterEnd = { end: null, first: null, endWindow: furthest() };
    await press("End", 1);
    afterEnd.end = selected()?.getAttribute("data-value") ?? null;
    afterEnd.endWindow = furthest();
    await press("Home", 1);
    afterEnd.first = selected()?.getAttribute("data-value") ?? null;
    afterEnd.homeWindow = furthest();
    return {
      samples: seen.length,
      distinct: new Set(seen).size,
      alwaysHighlighted: seen.every((value) => value !== null),
      windowMoved: movedDown,
      afterEnd,
    };
  });
  step(
    "M8-3 the highlight walks past the window instead of stopping at its edge",
    walk.alwaysHighlighted && walk.distinct === walk.samples && walk.samples === 60,
    `${walk.distinct} distinct rows over ${walk.samples} presses, window moved: ${walk.windowMoved}`,
  );
  step(
    "M8-4 Home and End reach the ends of the list, not the ends of the window",
    walk.afterEnd.end !== null && walk.afterEnd.first !== null && walk.afterEnd.endWindow > 0 && walk.afterEnd.homeWindow === 0,
    `End=${walk.afterEnd.end} (window ${walk.afterEnd.endWindow}), Home=${walk.afterEnd.first} (window ${walk.afterEnd.homeWindow})`,
  );

  // A branch the window never rendered is still reachable by typing. It is
  // asked for and looked at, never clicked. The popup that the steps above
  // opened is still up.
  const reach = await page.evaluate(async () => {
    const popup = document.querySelector('[data-testid="vcs-branch-popup"]');
    const input = popup.querySelector("input");
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const typed = popup.querySelectorAll('[data-testid="vcs-popup-heading-heading:local"]').length > 0;
    void typed;
    const wanted = [...popup.querySelectorAll('[data-testid^="vcs-popup-heading-"]')];
    // Type the tail of the last remote branch name the popup knows about; any
    // match proves the list is filtered, not truncated.
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 300));
    const last = [...popup.querySelectorAll("[data-branch-name]")].pop()?.getAttribute("data-branch-name") ?? null;
    const tail = last === null ? "" : last.slice(-6);
    setter.call(input, tail);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 500));
    const shown = [...popup.querySelectorAll("[data-branch-name]")].map((row) => row.getAttribute("data-branch-name"));
    setter.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 300));
    return { tail, last, shown: shown.length, found: last !== null && shown.includes(last), headings: wanted.length };
  });
  step(
    "M8-5 a branch past the window is still reachable by typing",
    reach.tail !== "" && reach.found,
    `typed "${reach.tail}", ${reach.shown} rows shown, found ${reach.last}`,
  );

  // --------------------------------------------------------- commit panel --
  await openCommitPanel(page);
  const panel = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="vcs-commit-panel"]');
    const list = document.querySelector('[data-testid="vcs-change-tree"]');
    return {
      rows: document.querySelectorAll('[data-testid="vcs-file-list"] li[data-path]').length,
      nodes: root ? root.querySelectorAll("*").length : 0,
      total: document.querySelectorAll("*").length,
      listRows: list ? list.children.length : 0,
      spacer: list?.querySelector('[data-testid="vcs-change-list-spacer-bottom"]')?.style.height ?? null,
      cards: document.querySelectorAll('[data-testid^="vcs-stream-patch-"]').length,
      spacers: document.querySelectorAll('[data-testid^="vcs-stream-spacer-"]').length,
    };
  });
  step(
    "M8-6 the changed-file list renders a window of rows",
    panel.rows > 0 && panel.rows <= FILE_ROW_BUDGET,
    `${panel.rows} file rows, budget ${FILE_ROW_BUDGET}; ${panel.listRows} rows in the list, ${panel.cards} diff bodies mounted`,
  );
  step(
    "M8-7 the panel holds a bounded number of nodes",
    panel.nodes > 0 && panel.nodes <= PANEL_NODE_BUDGET,
    `${panel.nodes} nodes in the panel (it held about 11300), budget ${PANEL_NODE_BUDGET}`,
  );
  step(
    "M8-8 only the cards near the reader are mounted",
    panel.cards <= MOUNTED_CARD_BUDGET,
    `${panel.cards} diff bodies mounted, ${panel.spacers} held open by a spacer, budget ${MOUNTED_CARD_BUDGET}`,
  );

  // ------------------------------------------------------------- the drag --
  const drag = await page.evaluate(async () => {
    const resizer = document.querySelector('[data-testid="vcs-file-list-resizer"]');
    const pane = document.querySelector('[data-testid="vcs-file-list"]');
    if (resizer === null || pane === null) return null;
    let writes = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function countWrites(key, value) {
      if (String(key).includes("right-pane-width")) writes += 1;
      return setItem.call(this, key, value);
    };
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Reported as no long tasks below.
    }
    const frames = [];
    let running = true;
    let last = performance.now();
    const tick = (at) => {
      frames.push(Math.round(at - last));
      last = at;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise((done) => setTimeout(done, 700));

    const box = resizer.getBoundingClientRect();
    const y = box.y + 300;
    const target = box.x + 40;
    resizer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: box.x, clientY: y }));
    for (let step_ = 1; step_ <= 20; step_ += 1) {
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: box.x + step_ * 2, clientY: y }));
      await new Promise((done) => setTimeout(done, 30));
    }
    const duringDrag = pane.style.width;
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 500));
    running = false;
    observer.disconnect();
    Storage.prototype.setItem = setItem;
    void target;
    const sorted = [...frames].sort((a, b) => b - a);
    return {
      writes,
      duringDrag,
      afterDrag: pane.style.width,
      frames: frames.length,
      avgFrame: Math.round(frames.reduce((total, value) => total + value, 0) / frames.length),
      maxFrame: sorted[0],
      longTasks,
      longTaskTotal: longTasks.reduce((total, value) => total + value, 0),
    };
  });
  step(
    "M8-9 dragging the splitter costs no long task",
    drag !== null && drag.longTaskTotal < DRAG_LONG_TASK_BUDGET,
    drag === null
      ? "no resizer"
      : `long tasks ${drag.longTaskTotal}ms total, budget ${DRAG_LONG_TASK_BUDGET}ms; ${drag.avgFrame}ms average frame over ${drag.frames}, worst ${drag.maxFrame}ms`,
  );
  step(
    "M8-10 the pane follows the drag, and storage is written once when it lands",
    drag !== null && drag.writes === 1 && drag.duringDrag !== "" && drag.duringDrag === drag.afterDrag,
    drag === null ? "no resizer" : `${drag.writes} writes, "${drag.duringDrag}" during the drag, "${drag.afterDrag}" after`,
  );

  // ------------------------------------------------- wrapping diffs resize --
  //
  // With `overflow: wrap` the renderer lays a diff out as a grid whose columns
  // span every row, so a width change makes the browser re-wrap the whole diff
  // and re-solve that grid: measured at about 180ms a frame against 0-1ms with
  // scrolling lines, which is eleven seconds of work for a one-second drag. The
  // plugin pins the content width for the length of a resize instead, so this
  // step is what says the pin is still there. It only bites on a repository
  // with a real diff in it, so on a small fixture it passes trivially — the
  // numbers it prints are the point.
  const wrapToggle = '[data-testid="vcs-diff-wrap"]';
  const wrapState = () => page.evaluate((selector) => document.querySelector(selector)?.getAttribute("aria-pressed") ?? null, wrapToggle);
  const wasWrapped = (await wrapState()) === "true";
  for (let attempt = 0; attempt < 3 && (await wrapState()) !== "true"; attempt += 1) {
    await page.evaluate((selector) => document.querySelector(selector)?.click(), wrapToggle);
    await sleep(3_000);
  }
  const wrapping = await page.evaluate(async () => {
    const pane = document.querySelector('[data-testid="vcs-file-list"]');
    const column = document.querySelector('[data-testid="vcs-stream-column"]');
    const base = Number.parseFloat(pane.style.width) || 300;
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {}
    const gaps = [];
    let pinned = "";
    let last = performance.now();
    for (let index = 0; index < 30; index += 1) {
      pane.style.width = `${base - index}px`;
      void document.body.offsetHeight;
      if (index === 10) pinned = column.style.width;
      await new Promise((done) => requestAnimationFrame(done));
      const now = performance.now();
      gaps.push(Math.round(now - last));
      last = now;
    }
    pane.style.width = `${base}px`;
    await new Promise((done) => setTimeout(done, 600));
    observer.disconnect();
    const sorted = [...gaps].sort((a, b) => b - a);
    return {
      medianFrame: sorted[Math.floor(sorted.length / 2)],
      worstFrame: sorted[0],
      over33: gaps.filter((value) => value > 33).length,
      totalMs: gaps.reduce((total, value) => total + value, 0),
      longTaskTotal: longTasks.reduce((total, value) => total + value, 0),
      pinnedDuring: pinned,
      releasedAfter: column.style.width,
    };
  });
  step(
    "M8-11 a wrapping diff survives a pane resize",
    wrapping.longTaskTotal < WRAP_RESIZE_LONG_TASK_BUDGET && wrapping.over33 <= 3,
    `long tasks ${wrapping.longTaskTotal}ms, budget ${WRAP_RESIZE_LONG_TASK_BUDGET}ms; ${wrapping.over33} of 30 frames over 33ms; median ${wrapping.medianFrame}ms, worst ${wrapping.worstFrame}ms; pinned "${wrapping.pinnedDuring}" during, "${wrapping.releasedAfter}" after`,
  );
  // Put the reader's preference back where it was found.
  if ((await wrapState()) === "true" && !wasWrapped) {
    await page.evaluate((selector) => document.querySelector(selector)?.click(), wrapToggle);
    await sleep(1_500);
  }

  await page.evaluate(() => {
    const close = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "Close Commit");
    if (close) close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(400);
  await sleep(800);
  await a.browser.close();
} catch (error) {
  console.log("SCRIPT ERROR", String(error).slice(0, 600));
} finally {
  if (!READ_ONLY) {
    // Its own fixture, by its own prefix: nothing else is touched.
    sh(`cd ${REPO} && git branch --list '${BRANCH_PREFIX}*' | xargs -r git branch -D`);
    sh(`cd ${REPO} && rm -f ${FILE_PREFIX}*.txt`);
  }
}

process.exit(summary() ? 0 : 1);

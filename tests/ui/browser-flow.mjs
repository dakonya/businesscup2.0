// Optional browser QA runner. Use an installed Playwright runtime; no app dependency is added.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.INCIDENTLAB_PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.INCIDENTLAB_URL || "http://127.0.0.1:3000";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const report = [];
const checkpoint = async (label, test) => { await test(); report.push(label); console.log(`PASS ${label}`); };
const saved = p => p.evaluate(() => JSON.parse(localStorage.getItem(sessionStorage.getItem("incidentlab.tab.snapshot.v1"))));
const metric = (label, p = page) => p.getByLabel("Current computed metrics").locator(".metric").filter({ has: p.getByText(label, { exact: true }) }).locator("strong");
await mkdir("docs/demo/screenshots", { recursive: true });
try {
  await page.goto(baseURL);
  await page.getByRole("button", { name: "Start practice", exact: true }).waitFor();
  await page.screenshot({ path: "docs/demo/screenshots/welcome.png", fullPage: true });
  await checkpoint("start, automatic checkpoint and inspect while paused", async () => {
    await page.getByRole("button", { name: "Start practice", exact: true }).click();
    await page.locator(".playback-time strong").getByText("00:20", { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator(".playback-state").innerText(), "Paused");
    await page.getByRole("button", { name: /^Failed / }).click();
    await page.getByRole("button", { name: /Inspect$/ }).first().click();
    await page.getByRole("heading", { name: /r\d+/ }).waitFor();
    const before = await page.locator(".playback-time").innerText();
    await page.waitForTimeout(600);
    assert.equal(await page.locator(".playback-time").innerText(), before);
  });
  await checkpoint("one intervention on double click; actual consequences", async () => {
    await page.getByRole("group", { name: "API replicas", exact: true }).getByRole("button", { name: "4", exact: true }).dblclick();
    assert.equal(await page.locator(".action-log li").count(), 1);
    await page.getByRole("button", { name: "Run to end" }).click();
    assert.equal(await metric("Failed").innerText(), "800");
    assert.equal(await metric("Successful").innerText(), "120");
    await page.getByRole("button", { name: "Save attempt", exact: true }).click();
    await page.screenshot({ path: "docs/demo/screenshots/attempt-a.png", fullPage: true });
  });
  let original;
  await checkpoint("rewind preserves A, excludes checkpoint decision, independent B", async () => {
    original = (await saved(page)).attempts[0];
    await page.getByRole("button", { name: "Rewind & branch" }).dblclick();
    assert.equal(await page.locator(".attempt-tab").count(), 2);
    assert.equal(await page.locator(".action-log li").count(), 0);
    assert.equal(await page.getByRole("group", { name: "API replicas", exact: true }).getByRole("button", { name: "2", exact: true }).getAttribute("aria-pressed"), "true");
    await page.getByRole("group", { name: "Maximum attempts", exact: true }).getByRole("button", { name: "1", exact: true }).dblclick();
    assert.equal(await page.locator(".action-log li").count(), 1);
    await page.getByRole("button", { name: "Run to end" }).click();
    assert.equal(await metric("Successful").innerText(), "709");
    assert.equal(await metric("Failed").innerText(), "248");
    assert.equal(await metric("Pending").innerText(), "3");
    assert.deepEqual((await saved(page)).attempts[0], original);
    await page.screenshot({ path: "docs/demo/screenshots/workspace.png", fullPage: true });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "docs/demo/screenshots/workspace-overview.png" });
  });
  await checkpoint("same-horizon comparison and grounded coach", async () => {
    await page.getByRole("button", { name: "Compare attempts", exact: true }).click();
    await page.getByRole("heading", { name: "Compare the consequences" }).waitFor();
    assert.match(await page.locator(".compare-table").innerText(), /\+589/);
    assert.match(await page.locator(".compare-table").innerText(), /−552/);
    await page.getByRole("button", { name: "Get comparison debrief" }).click();
    await page.locator(".coach-source").waitFor({ timeout: 25000 });
    const source = await page.locator(".coach-source").innerText();
    assert.ok(["Rule-based recap", "AI debrief"].includes(source));
    report.push(`coach source: ${source}`);
    await page.getByRole("button", { name: /Attempt B · Evidence/ }).first().click();
    assert.equal(await page.locator(".attempt-tab.active").innerText().then(t => t.startsWith("Attempt B")), true);
    await page.locator(".compare-panel").screenshot({ path: "docs/demo/screenshots/comparison.png" });
  });
  await checkpoint("reload restores specs and cursor", async () => {
    await page.getByRole("button", { name: "Save attempt", exact: true }).click();
    const before = await saved(page);
    await page.reload();
    await page.getByRole("button", { name: "Resume saved practice" }).click();
    assert.deepEqual(await saved(page), before);
  });
  await checkpoint("independent tabs and corrupted localStorage recovery", async () => {
    const second = await context.newPage();
    await second.goto(baseURL);
    await second.getByRole("button", { name: "Start practice", exact: true }).click();
    await second.getByRole("button", { name: "Pause simulation" }).click();
    const firstKey = await page.evaluate(() => sessionStorage.getItem("incidentlab.tab.snapshot.v1"));
    const secondKey = await second.evaluate(() => sessionStorage.getItem("incidentlab.tab.snapshot.v1"));
    assert.notEqual(firstKey, secondKey);
    const firstSaved = await saved(page);
    await second.getByRole("group", { name: "API replicas", exact: true }).getByRole("button", { name: "8", exact: true }).click();
    assert.deepEqual(await saved(page), firstSaved);
    await second.evaluate(() => localStorage.setItem(sessionStorage.getItem("incidentlab.tab.snapshot.v1"), "{broken"));
    await second.reload();
    await second.getByText("Saved practice could not be read. Start a new session.", { exact: true }).waitFor();
    await second.getByRole("button", { name: "Start practice", exact: true }).click();
    await second.getByRole("button", { name: "Pause simulation" }).click();
    await second.close();
  });
  await checkpoint("past edits require explicit branch, including after reload", async () => {
    const slider = page.getByRole("slider", { name: "Model time" });
    await slider.focus(); await slider.press("Home");
    await page.getByRole("button", { name: "Create branch from here" }).waitFor();
    assert.ok(await page.getByRole("group", { name: "Maximum attempts", exact: true }).getByRole("button", { name: "2", exact: true }).isDisabled());
    await page.reload();
    await page.getByRole("button", { name: "Resume saved practice" }).click();
    await page.getByRole("button", { name: "Create branch from here" }).click();
    assert.equal(await page.locator(".attempt-tab").count(), 3);
  });
  await checkpoint("coach failure, retry, and stale response after branch switch", async () => {
    await page.route("**/api/coach", route => route.fulfill({ status: 503, body: "Unavailable" }));
    await page.getByRole("button", { name: "Debrief", exact: true }).click();
    await page.getByRole("button", { name: "Get debrief", exact: true }).click();
    await page.getByRole("button", { name: "Retry coach", exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Play simulation" }).isEnabled());
    await page.unroute("**/api/coach");
    await page.route("**/api/coach", async route => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: "rules", summary: "STALE_REPLY_SHOULD_NOT_RENDER", observations: [], nextExperiment: "Try one change.", limitations: [] }) }); } catch {}
    });
    await page.getByRole("button", { name: "Retry coach", exact: true }).click();
    await page.locator(".attempt-tab").first().click();
    await page.waitForTimeout(1300);
    assert.equal(await page.getByText("STALE_REPLY_SHOULD_NOT_RENDER").count(), 0);
    await page.unroute("**/api/coach");
  });
  await checkpoint("coach wait is bounded; model text remains plain text", async () => {
    let pendingRoute;
    await page.route("**/api/coach", route => { pendingRoute = route; });
    await page.getByRole("button", { name: "Get debrief", exact: true }).click();
    await page.getByRole("button", { name: "Reviewing…", exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry coach", exact: true }).waitFor({ timeout: 25000 });
    assert.match(await page.locator(".coach-panel .message").innerText(), /took too long/);
    if (pendingRoute) await pendingRoute.abort().catch(() => {});
    await page.unroute("**/api/coach");
    const text = '<img src=x onerror="window.unsafeCoach=true">';
    await page.route("**/api/coach", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ source: "rules", summary: text, observations: [], nextExperiment: "UI safety fixture only.", limitations: [] }) }));
    await page.getByRole("button", { name: "Retry coach", exact: true }).click();
    await page.getByText(text, { exact: true }).waitFor();
    assert.equal(await page.locator(".coach-response img").count(), 0);
    assert.equal(await page.evaluate(() => window.unsafeCoach), undefined);
    await page.unroute("**/api/coach");
    await page.locator(".attempt-tab").nth(1).click();
  });
  await checkpoint("360px layout, keyboard controls, no page overflow", async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole("button", { name: "Save attempt", exact: true }).focus();
    assert.equal(await page.getByRole("button", { name: "Save attempt", exact: true }).evaluate(el => document.activeElement === el), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: "docs/demo/screenshots/mobile.png", fullPage: true });
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: report, pageErrors: errors }, null, 2));
} finally { await browser.close(); }

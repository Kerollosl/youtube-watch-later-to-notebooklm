// Scrape YouTube Watch Later -> create NotebookLM notebook(s) -> add each video
// as a YouTube source -> wait for processing -> ask the notebook for a summary
// via the local notebooklm skill -> save summary.
//
// Usage: npm start
//
// First run opens Chrome and waits for you to sign into Google in the visible
// window. The session persists in ./.user-data/ for re-runs.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DATA_DIR = path.join(__dirname, '.user-data');
const NOTEBOOKLM_SKILL_DIR = path.join(os.homedir(), '.claude/skills/notebooklm');
const TS = new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[:]/g, '-');
const VIDEOS_PATH = path.join(__dirname, `watch-later-${TS}.json`);
const LOG_PATH = path.join(__dirname, 'notebooks-created.log');

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 25_000;
const SOURCE_PROCESS_POLL_MS = 5000;
const SOURCE_PROCESS_TIMEOUT_MS = 20 * 60 * 1000;

const SUMMARY_QUESTION =
    'Summarize the main idea/points of each and every one of these sources in a few sentences max. Make sure not to forget any in your output.';

function log(msg) {
    console.log(msg);
}

function appendLog(line) {
    fs.appendFileSync(LOG_PATH, line + '\n');
}

// ---------------------------------------------------------------------------
// Auth: detect by probing a gated YouTube URL.
// ---------------------------------------------------------------------------
async function probeSignedIn(ctx) {
    // YouTube doesn't redirect /playlist?list=WL to signin when signed out — it
    // just shows "The playlist does not exist." So we probe the home page and
    // look for the "Sign in" CTA, which only renders when signed out.
    const probe = await ctx.newPage();
    try {
        await probe.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await probe.waitForTimeout(2000);
        const signedOut = await probe
            .locator(
                'a[aria-label="Sign in"], yt-button-view-model:has-text("Sign in"), a[href*="accounts.google.com/ServiceLogin"]'
            )
            .first()
            .isVisible()
            .catch(() => false);
        if (signedOut) return false;
        const avatar = await probe
            .locator('button#avatar-btn, button[aria-label*="Account menu" i], #avatar-btn')
            .first()
            .isVisible()
            .catch(() => false);
        return avatar;
    } finally {
        await probe.close().catch(() => {});
    }
}

async function ensureSignedIn(ctx, page) {
    if (await probeSignedIn(ctx)) {
        log('Already signed in. Continuing.');
        return;
    }
    await page
        .goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT })
        .catch(() => {});
    log('\n>>> Not signed in. A Chrome window is open — please sign in to Google.');
    log('    The script polls every 4s and resumes automatically (15 min timeout).');
    const start = Date.now();
    while (Date.now() - start < 15 * 60 * 1000) {
        await new Promise((r) => setTimeout(r, 4000));
        if (await probeSignedIn(ctx)) {
            log('Sign-in detected. Continuing.');
            return;
        }
    }
    throw new Error('Timed out waiting for Google sign-in.');
}

// ---------------------------------------------------------------------------
// Phase 1: scrape YouTube Watch Later.
// ---------------------------------------------------------------------------
async function scrapeWatchLater(page) {
    log('\n=== Scraping YouTube Watch Later ===');
    await page.goto('https://www.youtube.com/playlist?list=WL', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
    });

    await page.locator('ytd-playlist-video-renderer').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

    // Scroll until video count stops growing.
    let prev = -1;
    let count = await page.locator('ytd-playlist-video-renderer').count();
    let stableTicks = 0;
    while (stableTicks < 3) {
        prev = count;
        await page.keyboard.press('End');
        await page.waitForTimeout(1500);
        count = await page.locator('ytd-playlist-video-renderer').count();
        log(`  loaded ${count} videos${count === prev ? ' (stable)' : ''}`);
        if (count === prev) stableTicks++;
        else stableTicks = 0;
    }

    const videos = await page.$$eval('ytd-playlist-video-renderer', (els) =>
        els
            .map((e) => {
                const a = e.querySelector('a#video-title, a.yt-simple-endpoint#video-title');
                const titleEl = e.querySelector('#video-title');
                const channelEl = e.querySelector('ytd-channel-name a, #channel-name a');
                const durationEl = e.querySelector(
                    '#text.ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text, ytd-thumbnail-overlay-time-status-renderer span'
                );
                const href = a?.getAttribute('href') || '';
                const m = href.match(/[?&]v=([^&]+)/);
                const id = m ? m[1] : null;
                return {
                    id,
                    title: (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(),
                    channel: (channelEl?.textContent || '').trim(),
                    duration: (durationEl?.textContent || '').trim(),
                    url: id ? `https://www.youtube.com/watch?v=${id}` : '',
                };
            })
            .filter((v) => v.id)
    );

    // Dedupe by id (Watch Later sometimes shows duplicates while loading).
    const seen = new Set();
    const dedup = videos.filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));

    fs.writeFileSync(VIDEOS_PATH, JSON.stringify(dedup, null, 2));
    log(`  -> wrote ${dedup.length} videos to ${path.basename(VIDEOS_PATH)}`);
    return dedup;
}

// ---------------------------------------------------------------------------
// Phase 2: create NotebookLM notebook + add YouTube sources.
// ---------------------------------------------------------------------------
async function createNotebook(page) {
    log('\n=== Creating NotebookLM notebook ===');
    await page.goto('https://notebooklm.google.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(3000);

    await page.locator('button[aria-label="Create new notebook"]').first().click();

    // Wait for a real notebook UUID URL (not the transient /notebook/creating).
    await page.waitForURL(/\/notebook\/[0-9a-f]{8}-[0-9a-f]{4}-/i, { timeout: NAV_TIMEOUT });
    // Let the URL settle in case it changes once more.
    await page.waitForTimeout(2500);
    const notebookUrl = page.url().split('?')[0].replace(/\/$/, '');
    log(`  notebook URL: ${notebookUrl}`);
    return notebookUrl;
}

async function addAllSourcesViaPaste(page, urls) {
    log(`\n=== Adding ${urls.length} sources via bulk paste ===`);

    // After /notebook/<id>?addSource=true the source-picker modal auto-opens.
    // Wait specifically for the open mat-dialog-container (other [role="dialog"]
    // elements like the hidden emoji keyboard would otherwise confuse detection).
    const dialog = page.locator('mat-dialog-container.mdc-dialog--open').first();
    await dialog.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

    // Click the "Websites" / link source category — its tile contains the
    // "video_youtube" icon and accepts both plain URLs and YouTube links.
    await dialog.locator('button:has-text("Websites")').first().click();

    // The Paste-any-links textarea appears.
    const ta = dialog
        .locator('textarea[placeholder="Paste any links"], textarea[aria-label="Enter URLs"]')
        .first();
    await ta.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    await ta.click();
    // pressSequentially ensures NotebookLM's input listeners fire and the
    // submit button transitions from disabled to enabled.
    await ta.pressSequentially(urls.join('\n'), { delay: 4 });

    // After clicking "Websites" and typing URLs, the dialog shows an "Insert"
    // button (regular text button, not the icon-only Submit from the discover view).
    const insert = dialog.locator('button:has-text("Insert")').first();
    await insert.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    const enableStart = Date.now();
    while (Date.now() - enableStart < ACTION_TIMEOUT) {
        const disabled = await insert.getAttribute('disabled').catch(() => null);
        if (!disabled) break;
        await page.waitForTimeout(300);
    }
    await insert.click();
    log('  submitted — sources are now processing.');
    await page.waitForTimeout(3000);
    return urls.length;
}

async function renameNotebookSafely(page, title) {
    log(`\n=== Renaming notebook to "${title}" ===`);
    // The title is .cover-title in the notebook header. Clicking it reveals an
    // input.title-input pre-filled with the current title.
    try {
        const cover = page.locator('.cover-title').first();
        await cover.waitFor({ state: 'visible', timeout: 8_000 });
        await cover.click();
        const input = page.locator('input.title-input').first();
        await input.waitFor({ state: 'visible', timeout: 5_000 });
        await input.click({ clickCount: 3 }); // select all
        await input.press('Backspace');
        await input.type(title, { delay: 20 });
        await input.press('Enter');
        await page.waitForTimeout(700);
        log('  renamed.');
    } catch (err) {
        log(`  ! rename failed: ${err.message} (you can rename manually in the browser)`);
    }
}

async function waitAllSourcesReady(page, expectedCount) {
    log(`\n  waiting for all ${expectedCount} sources to finish processing...`);
    const start = Date.now();
    while (Date.now() - start < SOURCE_PROCESS_TIMEOUT_MS) {
        const ready = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.single-source-container')).filter(
                (e) => e.offsetParent !== null
            );
            const isProcessing = (el) =>
                !!el.querySelector(
                    'mat-spinner, mat-progress-spinner, [role="progressbar"], [class*="spinner" i], [class*="loading" i]'
                );
            const ready = rows.filter((r) => !isProcessing(r));
            return { visible: rows.length, ready: ready.length };
        });
        log(`    sources ready: ${ready.ready}/${ready.visible}`);
        if (ready.visible >= expectedCount && ready.ready >= expectedCount) return;
        await page.waitForTimeout(SOURCE_PROCESS_POLL_MS);
    }
    log('    ! timed out waiting for sources to fully process — proceeding anyway');
}

// ---------------------------------------------------------------------------
// Phase 3: shell out to the notebooklm skill to query the new notebook.
// ---------------------------------------------------------------------------
function summarizeNotebook(notebookUrl, outPath) {
    // Optional: only runs if the local notebooklm skill is installed at
    // ~/.claude/skills/notebooklm. Without it, the script still creates
    // notebooks and adds sources — you just open NotebookLM yourself
    // for the summary. Set SKIP_SUMMARY=1 to disable explicitly.
    if (process.env.SKIP_SUMMARY === '1' || !fs.existsSync(path.join(NOTEBOOKLM_SKILL_DIR, 'scripts/run.py'))) {
        log(`\n=== Skipping summary (notebooklm skill not installed at ${NOTEBOOKLM_SKILL_DIR}) ===`);
        log(`  Open the notebook in your browser to ask questions: ${notebookUrl}`);
        return;
    }
    log(`\n=== Querying notebook for summary ===`);
    log(`  URL: ${notebookUrl}`);
    log(`  saving to: ${path.basename(outPath)}`);
    const result = spawnSync(
        'python',
        [
            path.join(NOTEBOOKLM_SKILL_DIR, 'scripts/run.py'),
            'ask_question.py',
            '--question',
            SUMMARY_QUESTION,
            '--notebook-url',
            notebookUrl,
        ],
        { cwd: NOTEBOOKLM_SKILL_DIR, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const body = [
        `# Summary — ${notebookUrl}`,
        '',
        `**Generated:** ${new Date().toISOString()}`,
        '',
        `**Prompt:** ${SUMMARY_QUESTION}`,
        '',
        '---',
        '',
        stdout.trim() || '(no stdout from ask_question.py)',
        '',
        stderr.trim() ? `\n---\n\n## stderr\n\n\`\`\`\n${stderr.trim()}\n\`\`\`` : '',
    ].join('\n');
    fs.writeFileSync(outPath, body);
    if (result.status !== 0) {
        log(`  ! ask_question.py exited with code ${result.status} — partial output saved`);
    } else {
        log('  summary saved.');
    }
}

// ---------------------------------------------------------------------------
// Main orchestration.
// ---------------------------------------------------------------------------
async function main() {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });

    const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
    });
    ctx.setDefaultTimeout(ACTION_TIMEOUT);
    ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
    const page = ctx.pages()[0] || (await ctx.newPage());

    try {
        await ensureSignedIn(ctx, page);

        const videos = await scrapeWatchLater(page);
        if (videos.length === 0) {
            log('No videos found in Watch Later. Done.');
            return;
        }

        const baseTitle = `youtube watch later pull ${TS}`;

        // Free NotebookLM caps at 50 sources / notebook. Split into batches.
        const SOURCES_PER_NOTEBOOK = 50;
        const batches = [];
        for (let i = 0; i < videos.length; i += SOURCES_PER_NOTEBOOK) {
            batches.push(videos.slice(i, i + SOURCES_PER_NOTEBOOK));
        }
        log(`\nWill create ${batches.length} notebook(s) (${SOURCES_PER_NOTEBOOK} sources max each).`);

        const notebookUrls = [];
        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const title = batches.length > 1 ? `${baseTitle} [${bi + 1}/${batches.length}]` : baseTitle;

            let notebookUrl = await createNotebook(page);
            notebookUrls.push(notebookUrl);
            appendLog(`${new Date().toISOString()}\t${notebookUrl}\t${title}`);

            const urls = batch.map((v) => v.url);
            const added = await addAllSourcesViaPaste(page, urls);

            await waitAllSourcesReady(page, added);

            await renameNotebookSafely(page, title);

            // Re-read the URL in case it changed during processing.
            const finalUrl = page.url().split('?')[0].replace(/\/$/, '');
            if (finalUrl !== notebookUrl && /\/notebook\/[0-9a-f]{8}-/.test(finalUrl)) {
                log(`  notebook URL settled to: ${finalUrl}`);
                notebookUrls[notebookUrls.length - 1] = finalUrl;
                notebookUrl = finalUrl;
                appendLog(`${new Date().toISOString()}\t${finalUrl}\t${title} (settled)`);
            }

            const outPath = path.join(
                __dirname,
                `summary-${TS}${batches.length > 1 ? `-${bi + 1}of${batches.length}` : ''}.md`
            );
            summarizeNotebook(notebookUrl, outPath);
        }

        log('\n=== Done ===');
        log(`Notebooks created: ${notebookUrls.length}`);
        for (const u of notebookUrls) log(`  ${u}`);
    } finally {
        await ctx.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});

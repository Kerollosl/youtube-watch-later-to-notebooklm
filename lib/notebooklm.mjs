// Reusable NotebookLM loader: takes a list of URLs + a base name, opens
// NotebookLM in a persistent Chromium context, creates one or more notebooks
// (chunked at 50 sources each), bulk-pastes URLs, waits for processing, and
// renames the notebook(s). Optionally summarizes via the local notebooklm skill.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.join(REPO_ROOT, '.user-data');
const NOTEBOOKLM_SKILL_DIR = process.env.NOTEBOOKLM_SKILL_DIR || path.join(os.homedir(), '.claude/skills/notebooklm');
const LOG_PATH = path.join(REPO_ROOT, 'notebooks-created.log');

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 25_000;
const SOURCE_PROCESS_POLL_MS = 5000;
const SOURCE_PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const SOURCES_PER_NOTEBOOK = 50;

const DEFAULT_SUMMARY_QUESTION =
    'Summarize the main idea/points of each and every one of these sources in a few sentences max. Make sure not to forget any in your output.';

function log(msg) {
    console.log(msg);
}

function appendLog(line) {
    fs.appendFileSync(LOG_PATH, line + '\n');
}

function timestamp() {
    return new Date()
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z')
        .replace(/[:]/g, '-');
}

// ---------------------------------------------------------------------------
// Auth: detect by probing YouTube home for the "Sign in" CTA.
// ---------------------------------------------------------------------------
async function probeSignedIn(ctx) {
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

export async function ensureSignedIn(ctx, page) {
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
// Browser lifecycle
// ---------------------------------------------------------------------------
export async function launchBrowser() {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: ['--disable-blink-features=AutomationControlled'],
    });
    ctx.setDefaultTimeout(ACTION_TIMEOUT);
    ctx.setDefaultNavigationTimeout(NAV_TIMEOUT);
    const page = ctx.pages()[0] || (await ctx.newPage());
    return { ctx, page };
}

// ---------------------------------------------------------------------------
// NotebookLM operations
// ---------------------------------------------------------------------------
async function createNotebook(page) {
    log('\n=== Creating NotebookLM notebook ===');
    await page.goto('https://notebooklm.google.com/', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForTimeout(3000);

    await page.locator('button[aria-label="Create new notebook"]').first().click();

    await page.waitForURL(/\/notebook\/[0-9a-f]{8}-[0-9a-f]{4}-/i, { timeout: NAV_TIMEOUT });
    await page.waitForTimeout(2500);
    const notebookUrl = page.url().split('?')[0].replace(/\/$/, '');
    log(`  notebook URL: ${notebookUrl}`);
    return notebookUrl;
}

async function addAllSourcesViaPaste(page, urls) {
    log(`\n=== Adding ${urls.length} sources via bulk paste ===`);

    const dialog = page.locator('mat-dialog-container.mdc-dialog--open').first();
    await dialog.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

    await dialog.locator('button:has-text("Websites")').first().click();

    const ta = dialog
        .locator('textarea[placeholder="Paste any links"], textarea[aria-label="Enter URLs"]')
        .first();
    await ta.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    await ta.click();
    await ta.fill(urls.join('\n'));

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
    try {
        const cover = page.locator('.cover-title').first();
        await cover.waitFor({ state: 'visible', timeout: 8_000 });
        await cover.click();
        const input = page.locator('input.title-input').first();
        await input.waitFor({ state: 'visible', timeout: 5_000 });
        await input.click({ clickCount: 3 });
        await input.press('Backspace');
        await input.type(title, { delay: 20 });
        await input.press('Enter');
        await page.waitForTimeout(700);
        log('  renamed.');
    } catch (err) {
        log(`  ! rename failed: ${err.message} (you can rename manually in the browser)`);
    }
}

export async function waitAllSourcesReady(page, urls, {timeout=SOURCE_PROCESS_TIMEOUT_MS,poll=SOURCE_PROCESS_POLL_MS}={}) {
    const expectedCount=urls.length;
    log(`\n  waiting for all ${expectedCount} sources to finish processing...`);
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const ready = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('.single-source-container')).filter(
                (e) => e.offsetParent !== null
            );
            const isProcessing = (el) =>
                !!el.querySelector(
                    'mat-spinner, mat-progress-spinner, [role="progressbar"], [class*="spinner" i], [class*="loading" i]'
                );
            const failures=rows.filter(r=>/failed|could not|unable to|unsupported|error/i.test(r.textContent));
            const ready = rows.filter((r) => !isProcessing(r)&&!failures.includes(r));
            const sourceURLs=rows.flatMap(r=>[...r.querySelectorAll('a[href], [data-url], [data-source-url]')].map(a=>a.href||a.dataset.url||a.dataset.sourceUrl));
            return { visible: rows.length, ready: ready.length,failed:failures.length,sourceURLs };
        });
        log(`    sources ready: ${ready.ready}/${ready.visible}`);
        if(ready.failed)throw Error(`${ready.failed} sources failed; notebook retained for review`);
        if (ready.visible >= expectedCount && ready.ready >= expectedCount) {
            const videoId=u=>{try{const p=new URL(u);return p.searchParams.get('v')||p.pathname.split('/').pop();}catch{return null;}};
            const seen=new Set(ready.sourceURLs.map(videoId));
            if(!urls.every(url=>seen.has(videoId(url))))throw Error('Processed row count matched, but source URLs could not be verified. Notebook retained; inspect sources manually.');
            log('    ✓ All source identities verified.');
            return;
        }
        await page.waitForTimeout(poll);
    }
    throw Error('Source verification timed out; notebook retained, summary skipped');
}

// ---------------------------------------------------------------------------
// Optional summary via the local notebooklm skill
// ---------------------------------------------------------------------------
function summarizeNotebook(notebookUrl, outPath, question = DEFAULT_SUMMARY_QUESTION) {
    if (process.env.SKIP_SUMMARY === '1' || !fs.existsSync(path.join(NOTEBOOKLM_SKILL_DIR, 'scripts/run.py'))) {
        log(`\n=== Skipping summary (notebooklm skill not installed at ${NOTEBOOKLM_SKILL_DIR}) ===`);
        log(`  Open the notebook in your browser to ask questions: ${notebookUrl}`);
        return null;
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
            question,
            '--notebook-url',
            notebookUrl,
        ],
        { cwd: NOTEBOOKLM_SKILL_DIR, encoding: 'utf8', timeout: 180000, maxBuffer: 50 * 1024 * 1024 }
    );
    if(result.error || result.status!==0)throw Error('Summary helper failed or timed out');
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    const body = [
        `# Summary — ${notebookUrl}`,
        '',
        `**Generated:** ${new Date().toISOString()}`,
        '',
        `**Prompt:** ${question}`,
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
    return outPath;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
/**
 * Create one or more NotebookLM notebooks from a list of URLs.
 *
 * @param {string[]} urls       List of YouTube (or any web) URLs to add as sources.
 * @param {string}   baseName   Title prefix for the notebook(s). Timestamp is appended.
 * @param {object}   [opts]
 * @param {string}   [opts.summaryFilePrefix='summary']  Prefix for summary-*.md files.
 * @param {string}   [opts.summaryQuestion]              Override the summary prompt.
 * @param {object}   [opts.existingPage]                 Reuse an already-launched page.
 *                                                      If omitted, a new browser is launched and closed here.
 * @returns {Promise<{ notebooks: {url:string, title:string, sourceCount:number}[],
 *                     summaries: (string|null)[] }>}
 */
export async function createNotebookFromUrls(urls, baseName, opts = {}) {
    if (!Array.isArray(urls) || urls.length === 0) {
        throw new Error('createNotebookFromUrls: urls must be a non-empty array');
    }
    urls=[...new Set(urls)];
    const ledgerPath=path.join(REPO_ROOT,'notebook-progress.json');
    const ledger=fs.existsSync(ledgerPath)?JSON.parse(fs.readFileSync(ledgerPath,'utf8')):{};
    const saveLedger=()=>{const tmp=ledgerPath+'.tmp';fs.writeFileSync(tmp,JSON.stringify(ledger,null,2));fs.renameSync(tmp,ledgerPath);};
    const TS = timestamp();
    const summaryPrefix = opts.summaryFilePrefix ?? 'summary';
    const summaryQuestion = opts.summaryQuestion ?? DEFAULT_SUMMARY_QUESTION;

    let ctx = null;
    let page = opts.existingPage ?? null;
    let ownsBrowser = false;
    if (!page) {
        const launched = await launchBrowser();
        ctx = launched.ctx;
        page = launched.page;
        ownsBrowser = true;
        await ensureSignedIn(ctx, page);
    }

    const batches = [];
    for (let i = 0; i < urls.length; i += SOURCES_PER_NOTEBOOK) {
        batches.push(urls.slice(i, i + SOURCES_PER_NOTEBOOK));
    }
    log(`\nWill create ${batches.length} notebook(s) (${SOURCES_PER_NOTEBOOK} sources max each).`);

    const notebooks = [];
    const summaries = [];

    try {
        for (let bi = 0; bi < batches.length; bi++) {
            const batch = batches[bi];
            const title = batches.length > 1 ? `${baseName} ${TS} [${bi + 1}/${batches.length}]` : `${baseName} ${TS}`;

            const key=batch.join('\n');
            let record=ledger[key];
            let notebookUrl;
            if(record){
                notebookUrl=record.url;
                await page.goto(notebookUrl,{waitUntil:'domcontentloaded',timeout:NAV_TIMEOUT});
                // Existing submissions are only reconciled, never blindly resubmitted.
            }else{
                notebookUrl=await createNotebook(page);
                ledger[key]={url:notebookUrl,status:'created',urls:batch};saveLedger();
            }
            appendLog(`${new Date().toISOString()}\t${notebookUrl}\t${title}`);

            if(!record || record.status==='created'){
                ledger[key].status='submitting';saveLedger();
                await addAllSourcesViaPaste(page,batch);
            }
            const added=batch.length;
            await waitAllSourcesReady(page, batch);
            ledger[key].status='verified';saveLedger();
            await renameNotebookSafely(page, title);

            const finalUrl = page.url().split('?')[0].replace(/\/$/, '');
            if (finalUrl !== notebookUrl && /\/notebook\/[0-9a-f]{8}-/.test(finalUrl)) {
                log(`  notebook URL settled to: ${finalUrl}`);
                notebookUrl = finalUrl;
                appendLog(`${new Date().toISOString()}\t${finalUrl}\t${title} (settled)`);
            }

            notebooks.push({ url: notebookUrl, title, sourceCount: added });

            const outPath = path.join(
                REPO_ROOT,
                `${summaryPrefix}-${TS}${batches.length > 1 ? `-${bi + 1}of${batches.length}` : ''}.md`
            );
            summaries.push(summarizeNotebook(notebookUrl, outPath, summaryQuestion));
        }
    } finally {
        if (ownsBrowser && ctx) {
            await ctx.close().catch(() => {});
        }
    }

    return { notebooks, summaries };
}


// Scrape all videos from @masterpovs -> create a NotebookLM notebook.
//
// Usage:
//   node channel-masterpovs.mjs
//   node channel-masterpovs.mjs --max=50
//
// Session persists in ./.user-data/ (same as topic.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, ensureSignedIn, createNotebookFromUrls } from './lib/notebooklm.mjs';

const CHANNEL_HANDLE = '@masterpovs';
const CHANNEL_URL = `https://www.youtube.com/${CHANNEL_HANDLE}/videos`;
const NOTEBOOK_NAME = `Channel: ${CHANNEL_HANDLE}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 25_000;

function parseArgs(argv) {
    const args = { max: 50 };
    for (const a of argv.slice(2)) {
        const m = a.match(/^--max=(\d+)$/);
        if (m) args.max = parseInt(m[1], 10);
    }
    return args;
}

function slugify(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

// "5:23" -> 323; "1:02:45" -> 3765
function parseDuration(text) {
    if (!text) return 0;
    const parts = text.trim().split(':').map((p) => parseInt(p, 10));
    if (parts.some(Number.isNaN)) return 0;
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;
    return seconds;
}

async function getChannelVideos(page, max) {
    console.log(`\n=== Loading channel videos: ${CHANNEL_URL} ===`);
    await page.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    // Wait for video grid to appear
    await page
        .locator('ytd-rich-item-renderer, ytd-grid-video-renderer')
        .first()
        .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

    // Scroll until we have enough candidates or the page stops growing
    const target = Math.min(200, max * 2);
    let prev = -1;
    let stableTicks = 0;
    let count = await page.locator('ytd-rich-item-renderer, ytd-grid-video-renderer').count();

    while (count < target && stableTicks < 4) {
        prev = count;
        await page.keyboard.press('End');
        await page.waitForTimeout(1800);
        count = await page.locator('ytd-rich-item-renderer, ytd-grid-video-renderer').count();
        console.log(`  loaded ${count} items${count === prev ? ' (stable)' : ''}`);
        if (count === prev) stableTicks++;
        else stableTicks = 0;
    }

    const raw = await page.$$eval(
        'ytd-rich-item-renderer, ytd-grid-video-renderer',
        (els) =>
            els.map((e) => {
                const a = e.querySelector('a#video-title-link, a#thumbnail, a#video-title');
                const titleEl = e.querySelector('#video-title');
                const durationEl = e.querySelector(
                    'ytd-thumbnail-overlay-time-status-renderer #text, ytd-thumbnail-overlay-time-status-renderer span, .badge-shape-wiz__text'
                );
                const href = a?.getAttribute('href') || '';
                const isShort = href.includes('/shorts/');
                const m = href.match(/[?&]v=([^&]+)/);
                const id = m ? m[1] : null;
                return {
                    id,
                    url: id ? `https://www.youtube.com/watch?v=${id}` : '',
                    title: (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(),
                    durationText: (durationEl?.textContent || '').trim(),
                    isShort,
                };
            })
    );

    const seen = new Set();
    const picked = [];

    for (const v of raw) {
        if (!v.id || seen.has(v.id)) continue;
        seen.add(v.id);

        // Skip Shorts (URL-based check)
        if (v.isShort) continue;

        // Skip anything under 60s (catches unlabeled Shorts)
        const durationSeconds = parseDuration(v.durationText);
        if (v.durationText && durationSeconds < 60) continue;

        picked.push({ id: v.id, url: v.url, title: v.title, durationText: v.durationText });
        if (picked.length >= max) break;
    }

    return picked;
}

async function main() {
    const args = parseArgs(process.argv);
    const max = Math.min(args.max, 50);
    const slug = slugify(CHANNEL_HANDLE);
    const TS = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
    const candidatesPath = path.join(__dirname, `channel-${slug}-${TS}.json`);

    const { ctx, page } = await launchBrowser();
    try {
        await ensureSignedIn(ctx, page);

        const videos = await getChannelVideos(page, max);

        if (videos.length === 0) {
            console.error('No videos found on the channel.');
            process.exitCode = 2;
            return;
        }

        fs.writeFileSync(candidatesPath, JSON.stringify({ channel: CHANNEL_HANDLE, max, results: videos }, null, 2));
        console.log(`\n  picked ${videos.length} videos -> ${path.basename(candidatesPath)}`);
        for (const v of videos.slice(0, 10)) {
            console.log(`    ${(v.durationText || '?').padStart(7)}  ${v.title}`);
        }
        if (videos.length > 10) console.log(`    ... and ${videos.length - 10} more`);

        const urls = videos.map((v) => v.url);
        const result = await createNotebookFromUrls(urls, NOTEBOOK_NAME, {
            summaryFilePrefix: `summary-channel-${slug}`,
            existingPage: page,
        });

        console.log('\n=== Done ===');
        console.log(`Notebooks created: ${result.notebooks.length}`);
        for (const n of result.notebooks) {
            console.log(`  ${n.url}  (${n.sourceCount} sources)  ${n.title}`);
        }
    } finally {
        await ctx.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});

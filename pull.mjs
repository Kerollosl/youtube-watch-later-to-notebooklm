// Scrape YouTube Watch Later -> hand the URLs to lib/notebooklm.mjs which
// creates a NotebookLM notebook (or batches of 50) and adds each video as a
// source. Optionally summarizes via the local notebooklm skill.
//
// Usage: npm start
//
// First run opens Chrome and waits for you to sign into Google in the visible
// window. The session persists in ./.user-data/ for re-runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, ensureSignedIn, createNotebookFromUrls } from './lib/notebooklm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TS = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
const VIDEOS_PATH = path.join(__dirname, `watch-later-${TS}.json`);

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 25_000;

function log(msg) {
    console.log(msg);
}

async function scrapeWatchLater(page) {
    log('\n=== Scraping YouTube Watch Later ===');
    await page.goto('https://www.youtube.com/playlist?list=WL', {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
    });

    await page.locator('ytd-playlist-video-renderer').first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

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

    // Watch Later sometimes shows duplicates while loading.
    const seen = new Set();
    const dedup = videos.filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));

    fs.writeFileSync(VIDEOS_PATH, JSON.stringify(dedup, null, 2));
    log(`  -> wrote ${dedup.length} videos to ${path.basename(VIDEOS_PATH)}`);
    return dedup;
}

async function createTodoistTask(notebookUrls) {
    const token = process.env.TODOIST_API_KEY;
    if (!token) {
        log('Warning: TODOIST_API_KEY not set, skipping Todoist task creation.');
        return;
    }

    const notebookLines = notebookUrls.map((u) => `NotebookLM: ${u}`).join('\n');
    const description = `${notebookLines}\n\nWatch Later: https://www.youtube.com/playlist?list=WL`;

    const res = await fetch('https://api.todoist.com/api/v1/tasks', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            content: 'YT Watch Later NotebookLM',
            description,
        }),
    });

    if (!res.ok) {
        log(`Warning: Todoist task creation failed (${res.status})`);
        return;
    }

    const task = await res.json();
    log(`Todoist task created: ${task.url}`);
}

async function main() {
    const { ctx, page } = await launchBrowser();
    try {
        await ensureSignedIn(ctx, page);

        const videos = await scrapeWatchLater(page);
        if (videos.length === 0) {
            log('No videos found in Watch Later. Done.');
            return;
        }

        const urls = videos.map((v) => v.url);
        const result = await createNotebookFromUrls(urls, 'youtube watch later pull', {
            existingPage: page,
        });

        log('\n=== Done ===');
        log(`Notebooks created: ${result.notebooks.length}`);
        for (const n of result.notebooks) log(`  ${n.url}`);

        await createTodoistTask(result.notebooks.map((n) => n.url));
    } finally {
        await ctx.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});

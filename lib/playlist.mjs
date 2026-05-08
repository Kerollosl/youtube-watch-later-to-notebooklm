// Save a list of YouTube videos to a named playlist using the Save-to-playlist
// dialog on each video's watch page. Creates the playlist on first run.
//
// Reuses the already-signed-in Playwright page; no API key required.
//
// Strategy per video:
//   1. Navigate to https://www.youtube.com/watch?v=<id>
//   2. Find the Save-to-playlist control. YouTube exposes it in two shapes:
//      a) a top-level button[aria-label="Save to playlist"] in the action row, or
//      b) a "..." More-actions menu containing a "Save to playlist" item.
//   3. The Save dialog appears. Tick the named playlist's checkbox; if absent,
//      create it (Private), then close the dialog.

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 25_000;
// Per-video budget: opening the dialog can be flaky on first run, but spending
// >45s on a single video is a sign something is wrong — bail and move on.
const PER_VIDEO_TIMEOUT_MS = 45_000;

function isClosedError(err) {
    const msg = String(err?.message || err || '');
    return /Target page, context or browser has been closed|Browser has been closed|page closed/i.test(msg);
}

async function navigateToWatch(page, videoId) {
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT,
    });
    await page
        .locator('ytd-watch-metadata, #top-row.ytd-watch-metadata')
        .first()
        .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    // Let the action row hydrate.
    await page.waitForTimeout(800);
}

async function openSaveDialog(page) {
    // Strategy A: look for Save button anywhere on the page by text content.
    // This is more robust to DOM changes than trying to scope to a specific container.
    const directSaveVariants = [
        'button:has-text("Save")',
        'button[aria-label="Save to playlist"]',
    ];

    for (const selector of directSaveVariants) {
        const directSave = page.locator(selector).first();
        if (await directSave.isVisible({ timeout: 2000 }).catch(() => false)) {
            await directSave.click();
            const dlg = await waitForSaveDialog(page);
            if (dlg) return dlg;
        }
    }

    // Strategy B: open the More-actions ("...") menu, click "Save to playlist".
    // Try multiple selectors for the More button to handle different DOM structures.
    const moreButtonVariants = [
        'button[aria-label="More actions"]',
        'button:has-text("More actions")',
        'yt-button-shape button[aria-label="More actions"]',
    ];

    for (const selector of moreButtonVariants) {
        const moreBtn = page.locator(selector).first();
        if (await moreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await moreBtn.click();
            await page.waitForTimeout(300);
            const menuItem = page
                .locator(
                    'ytd-menu-service-item-renderer:has-text("Save to playlist"), tp-yt-paper-item:has-text("Save to playlist")'
                )
                .first();
            if (await menuItem.isVisible({ timeout: 2000 }).catch(() => false)) {
                await menuItem.click();
                const dlg = await waitForSaveDialog(page);
                if (dlg) return dlg;
            }
        }
    }

    throw new Error('Could not find a Save-to-playlist control on the watch page');
}

async function waitForSaveDialog(page) {
    const dialog = page.locator('tp-yt-paper-dialog, ytd-add-to-playlist-renderer').first();
    try {
        await dialog.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
        return dialog;
    } catch {
        return null;
    }
}

async function ensurePlaylistChecked(page, dialog, playlistName) {
    // If a "Find a playlist" filter exists, use it to narrow the list.
    const filter = dialog.locator('input[placeholder*="Find" i]').first();
    if (await filter.isVisible({ timeout: 1500 }).catch(() => false)) {
        await filter.fill(playlistName).catch(() => {});
        await page.waitForTimeout(400);
    }

    const row = dialog
        .locator(`ytd-playlist-add-to-option-renderer:has-text("${playlistName}")`)
        .first();
    if (await row.isVisible({ timeout: 1500 }).catch(() => false)) {
        const checkbox = row.locator('tp-yt-paper-checkbox, #checkbox').first();
        const checked = await checkbox.getAttribute('aria-checked').catch(() => 'false');
        if (checked !== 'true') {
            await checkbox.click();
            await page.waitForTimeout(300);
        }
        return 'existed';
    }

    // Not in the list — create it.
    const createBtn = dialog
        .locator(
            'ytd-add-to-playlist-create-renderer button, button:has-text("New playlist"), yt-button-shape:has(button:has-text("New playlist")) button'
        )
        .first();
    await createBtn.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    await createBtn.click();

    const nameInput = dialog
        .locator('input#title-form-text-input, input[aria-label*="Title" i], textarea#textarea')
        .first();
    await nameInput.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    await nameInput.click({ clickCount: 3 }).catch(() => {});
    await nameInput.fill(playlistName);

    // Best-effort: set privacy to Private. Falls back to default if dropdown isn't there.
    try {
        const privacyDropdown = dialog
            .locator('tp-yt-paper-dropdown-menu, paper-dropdown-menu, [role="combobox"]')
            .first();
        if (await privacyDropdown.isVisible({ timeout: 2000 }).catch(() => false)) {
            await privacyDropdown.click();
            await page.waitForTimeout(300);
            await page
                .locator('tp-yt-paper-item:has-text("Private"), [role="option"]:has-text("Private")')
                .first()
                .click({ timeout: 4000 })
                .catch(() => {});
        }
    } catch {
        /* ignore */
    }

    const submit = dialog
        .locator('button:has-text("Create"), yt-button-shape:has(button:has-text("Create")) button')
        .first();
    await submit.click();
    await page.waitForTimeout(800);
    return 'created';
}

async function safeCloseDialog(page) {
    try {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
    } catch {
        /* page closed; caller will detect via next step */
    }
}

// Run an async fn with a hard wall-clock cap so we can't get stuck on one video.
function withTimeout(promise, ms, label) {
    let to;
    return Promise.race([
        promise.finally(() => clearTimeout(to)),
        new Promise((_, rej) => {
            to = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
    ]);
}

/**
 * Save a list of videos to a named YouTube playlist. Creates the playlist
 * if it doesn't exist (Private by default).
 *
 * Resilient to per-video failures and to the browser/page being closed mid-run.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{id:string, title?:string}>} videos
 * @param {string} playlistName
 * @returns {Promise<{ created: boolean, saved: number, failed: number, aborted: boolean,
 *                    failures: Array<{id:string, error:string}> }>}
 */
export async function addVideosToYouTubePlaylist(page, videos, playlistName) {
    console.log(`\n=== Saving ${videos.length} videos to YouTube playlist "${playlistName}" ===`);
    let saved = 0;
    let failed = 0;
    let created = false;
    let aborted = false;
    const failures = [];

    for (let i = 0; i < videos.length; i++) {
        const v = videos[i];
        const tag = `[${i + 1}/${videos.length}]`;

        try {
            await withTimeout(
                (async () => {
                    await navigateToWatch(page, v.id);
                    const dialog = await openSaveDialog(page);
                    const status = await ensurePlaylistChecked(page, dialog, playlistName);
                    if (status === 'created') created = true;
                    await safeCloseDialog(page);
                    saved++;
                    const title = (v.title || v.id).slice(0, 70);
                    console.log(`  ${tag} ${status === 'created' ? '+playlist ' : ''}saved: ${title}`);
                })(),
                PER_VIDEO_TIMEOUT_MS,
                `video ${v.id}`
            );
        } catch (err) {
            if (isClosedError(err)) {
                aborted = true;
                console.log(`  ${tag} ! browser/page closed — aborting playlist step (${i}/${videos.length} processed)`);
                break;
            }
            failed++;
            failures.push({ id: v.id, error: err.message });
            console.log(`  ${tag} ! failed for ${v.id}: ${err.message}`);
            // Best-effort dialog close; never bubble.
            try {
                await page.keyboard.press('Escape');
            } catch {
                /* ignore */
            }
            try {
                await page.waitForTimeout(300);
            } catch (closedErr) {
                if (isClosedError(closedErr)) {
                    aborted = true;
                    console.log('  ! browser/page closed during recovery — aborting playlist step');
                    break;
                }
            }
        }
    }

    console.log(
        `  done — ${saved} saved, ${failed} failed${aborted ? ', aborted' : ''}${created ? ' (playlist newly created)' : ''}`
    );
    return { created, saved, failed, aborted, failures };
}

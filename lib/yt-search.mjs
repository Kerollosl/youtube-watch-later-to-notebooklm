// YouTube search by scraping youtube.com/results in the existing Playwright
// session. No API key — reuses the same browser auth as Watch Later.
//
// Trade-off vs the Data API: a bit more brittle if YouTube changes selectors,
// and the view-count text is approximate. But zero configuration to use.

const NAV_TIMEOUT = 60_000;
const ACTION_TIMEOUT = 25_000;

// `&sp=EgIQAQ%3D%3D` is YouTube's "Type: Video" filter (excludes channels,
// playlists, shorts shelves). Decoded protobuf: type=video.
const VIDEO_FILTER_SP = 'EgIQAQ%3D%3D';

// "5:23" -> 323; "1:02:45" -> 3765
function parseDuration(text) {
    if (!text) return 0;
    const parts = text.trim().split(':').map((p) => parseInt(p, 10));
    if (parts.some(Number.isNaN)) return 0;
    let seconds = 0;
    for (const p of parts) seconds = seconds * 60 + p;
    return seconds;
}

// "1.2M views" -> 1200000; "523K views" -> 523000; "no views" -> 0
function parseViews(text) {
    if (!text) return 0;
    const m = text.match(/([\d.,]+)\s*([KMB]?)/i);
    if (!m) return 0;
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (Number.isNaN(num)) return 0;
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] ?? 1;
    return Math.round(num * mult);
}

/**
 * Search YouTube for videos on a topic and return a curated list.
 *
 * Scrolls the results page until enough candidates are loaded, extracts each
 * video's title/channel/duration/views/URL, drops shorts and very-low-view
 * junk, caps videos per channel, and returns the top `max`.
 *
 * @param {import('playwright').Page} page  An already-signed-in Playwright page.
 * @param {string} topic
 * @param {object} [opts]
 * @param {number} [opts.max=50]
 * @param {number} [opts.minDurationSeconds=60]
 * @param {number} [opts.minViews=1000]
 * @param {number} [opts.maxPerChannel=3]
 * @returns {Promise<Array<{
 *   id: string, url: string, title: string, channel: string,
 *   durationSeconds: number, viewCount: number, durationText: string, viewsText: string
 * }>>}
 */
export async function searchYouTube(page, topic, opts = {}) {
    const max = opts.max ?? 50;
    const minDurationSeconds = opts.minDurationSeconds ?? 60;
    const minViews = opts.minViews ?? 1000;
    const maxPerChannel = opts.maxPerChannel ?? 3;

    const url = new URL('https://www.youtube.com/results');
    url.searchParams.set('search_query', topic);
    // Set sp directly (already encoded) so we don't double-encode.
    const target = `${url.toString()}&sp=${VIDEO_FILTER_SP}`;

    console.log(`\n  navigating to: ${target}`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await page
        .locator('ytd-video-renderer')
        .first()
        .waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

    // Aim for ~3x the desired count so filters don't starve the result.
    const candidateTarget = Math.min(200, max * 3);

    let prev = -1;
    let count = await page.locator('ytd-video-renderer').count();
    let stableTicks = 0;
    while (count < candidateTarget && stableTicks < 3) {
        prev = count;
        await page.keyboard.press('End');
        await page.waitForTimeout(1500);
        count = await page.locator('ytd-video-renderer').count();
        console.log(`  loaded ${count} candidates${count === prev ? ' (stable)' : ''}`);
        if (count === prev) stableTicks++;
        else stableTicks = 0;
    }

    const raw = await page.$$eval('ytd-video-renderer', (els) =>
        els.map((e) => {
            const a = e.querySelector('a#video-title, a#thumbnail');
            const titleEl = e.querySelector('#video-title');
            const channelEl = e.querySelector('ytd-channel-name a, #channel-name a');
            const durationEl = e.querySelector(
                'ytd-thumbnail-overlay-time-status-renderer #text, ytd-thumbnail-overlay-time-status-renderer span, .badge-shape-wiz__text'
            );
            const metaSpans = Array.from(e.querySelectorAll('#metadata-line span'));
            const viewsText = (metaSpans[0]?.textContent || '').trim();
            const href = a?.getAttribute('href') || '';
            const m = href.match(/[?&]v=([^&]+)/);
            const id = m ? m[1] : null;
            return {
                id,
                url: id ? `https://www.youtube.com/watch?v=${id}` : '',
                title: (titleEl?.getAttribute('title') || titleEl?.textContent || '').trim(),
                channel: (channelEl?.textContent || '').trim(),
                durationText: (durationEl?.textContent || '').trim(),
                viewsText,
                isShortBadge: !!e.querySelector('a[href*="/shorts/"]'),
            };
        })
    );

    // Dedupe + parse + filter, preserving relevance order.
    const seen = new Set();
    const perChannel = new Map();
    const picked = [];

    for (const v of raw) {
        if (!v.id || seen.has(v.id)) continue;
        seen.add(v.id);
        if (v.isShortBadge) continue;

        const durationSeconds = parseDuration(v.durationText);
        if (durationSeconds < minDurationSeconds) continue;

        const viewCount = parseViews(v.viewsText);
        if (viewCount < minViews) continue;

        const channelKey = v.channel.toLowerCase();
        const used = perChannel.get(channelKey) || 0;
        if (used >= maxPerChannel) continue;
        perChannel.set(channelKey, used + 1);

        picked.push({
            id: v.id,
            url: v.url,
            title: v.title,
            channel: v.channel,
            durationSeconds,
            viewCount,
            durationText: v.durationText,
            viewsText: v.viewsText,
        });
        if (picked.length >= max) break;
    }

    return picked;
}

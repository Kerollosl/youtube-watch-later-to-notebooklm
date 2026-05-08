// Search YouTube for a topic -> create a NotebookLM notebook with the results.
//
// Usage:
//   node topic.mjs "pidgeon migration patterns"
//   node topic.mjs "pidgeon migration patterns" --max=30
//   npm run topic -- "pidgeon migration patterns"
//
// First run opens Chrome and waits for you to sign into Google in the visible
// window. Session persists in ./.user-data/ for re-runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchYouTube } from './lib/yt-search.mjs';
import { addVideosToYouTubePlaylist } from './lib/playlist.mjs';
import { launchBrowser, ensureSignedIn, createNotebookFromUrls } from './lib/notebooklm.mjs';

const RESEARCH_PLAYLIST_NAME = 'Claude Research';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
    const args = { topic: null, max: 50, skipPlaylist: false };
    const rest = [];
    for (const a of argv.slice(2)) {
        const m = a.match(/^--max=(\d+)$/);
        if (m) {
            args.max = parseInt(m[1], 10);
            continue;
        }
        if (a === '--skip-playlist') {
            args.skipPlaylist = true;
            continue;
        }
        if (a === '--help' || a === '-h') {
            args.help = true;
            continue;
        }
        rest.push(a);
    }
    args.topic = rest.join(' ').trim() || null;
    return args;
}

function slugify(s) {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
}

async function main() {
    const args = parseArgs(process.argv);

    if (args.help || !args.topic) {
        console.log('Usage: node topic.mjs "<topic>" [--max=N] [--skip-playlist]');
        console.log('  --max=N         Max videos in the notebook (default 50, NotebookLM cap)');
        console.log('  --skip-playlist Skip saving videos to YouTube playlist (faster, default: save)');
        process.exit(args.help ? 0 : 1);
    }

    const topic = args.topic;
    const max = Math.min(args.max, 50);
    const slug = slugify(topic);
    const TS = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-');
    const candidatesPath = path.join(__dirname, `topic-${slug}-${TS}.json`);

    const { ctx, page } = await launchBrowser();
    try {
        await ensureSignedIn(ctx, page);

        console.log(`\n=== Searching YouTube for: "${topic}" (max ${max}) ===`);
        const videos = await searchYouTube(page, topic, { max });

        if (videos.length === 0) {
            console.error('No videos found that pass the filters. Try a broader topic.');
            process.exit(2);
        }

        fs.writeFileSync(candidatesPath, JSON.stringify({ topic, max, results: videos }, null, 2));
        console.log(`\n  picked ${videos.length} videos -> ${path.basename(candidatesPath)}`);
        for (const v of videos.slice(0, 10)) {
            console.log(`    ${v.durationText.padStart(7)}  ${v.viewsText.padStart(14)}  ${v.title}`);
        }
        if (videos.length > 10) console.log(`    ... and ${videos.length - 10} more`);

        const urls = videos.map((v) => v.url);
        const baseName = `Topic: ${topic}`;

        const result = await createNotebookFromUrls(urls, baseName, {
            summaryFilePrefix: `summary-topic-${slug}`,
            existingPage: page,
        });

        // Playlist save runs after NotebookLM so a YouTube DOM hiccup
        // can't crash the primary artifact. Can be skipped with --skip-playlist.
        let playlistResult = { saved: 0, failed: 0, aborted: false };
        if (!args.skipPlaylist) {
            try {
                playlistResult = await addVideosToYouTubePlaylist(page, videos, RESEARCH_PLAYLIST_NAME);
            } catch (err) {
                console.log(`\n! Playlist step failed: ${err.message} (notebook is still created)`);
            }
        } else {
            console.log('\n=== Skipping playlist save (--skip-playlist) ===');
        }

        console.log('\n=== Done ===');
        console.log(`Notebooks created: ${result.notebooks.length}`);
        for (const n of result.notebooks) {
            console.log(`  ${n.url}  (${n.sourceCount} sources)  ${n.title}`);
        }
        console.log(
            `Playlist "${RESEARCH_PLAYLIST_NAME}": ${playlistResult.saved}/${videos.length} saved` +
                (playlistResult.failed ? `, ${playlistResult.failed} failed` : '')
        );
    } finally {
        await ctx.close().catch(() => {});
    }
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});

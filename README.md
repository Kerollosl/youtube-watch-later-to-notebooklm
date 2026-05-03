# youtube-watch-later-to-notebooklm

Pull every video from your YouTube **Watch Later** playlist and load them into a fresh [NotebookLM](https://notebooklm.google.com/) notebook as YouTube sources. Auto-batches into multiple notebooks if you exceed NotebookLM's 50-source limit.

Useful when you've stockpiled hundreds of "I'll watch later" videos and want NotebookLM to summarize, search, and ask questions across all of them at once.

## What it does

1. Opens YouTube in Chromium and waits for you to sign in (first run only)
2. Scrolls the entire `playlist?list=WL` page to load every video
3. Extracts each video's title, channel, duration, and URL
4. Opens NotebookLM and creates a new notebook
5. Bulk-pastes all video URLs into the source picker
6. Waits for NotebookLM to finish processing every source
7. Renames the notebook with a timestamp
8. (Optional) Asks NotebookLM to summarize all sources and saves the response as Markdown

If you have more than 50 videos, it automatically splits into multiple notebooks.

## Requirements

- Node.js 18+
- A Google account with YouTube + NotebookLM access (NotebookLM is free)
- ~100 MB free disk space (Chromium binary)

## Setup

```bash
git clone https://github.com/Kerollosl/youtube-watch-later-to-notebooklm.git
cd youtube-watch-later-to-notebooklm
npm install            # installs a local Chromium via Playwright
```

## Usage

```bash
npm start
```

**First run:** A Chromium window opens. Sign in to your Google account. The script polls every 4 seconds and resumes automatically. Your session is saved in `.user-data/` (gitignored) for subsequent runs — no need to log in again.

**Subsequent runs:** It detects you're already signed in and proceeds straight to scraping.

## What you get

Per run, the script creates:

| File | Contents |
|------|----------|
| `watch-later-<TS>.json` | Every video extracted from your Watch Later (id, title, channel, URL, duration) |
| `notebooks-created.log` | Append-only log of every notebook created with timestamps and URLs |
| One or more NotebookLM notebooks | Visible at https://notebooklm.google.com/ — named `youtube watch later pull <TS>` |
| `summary-<TS>.md` (optional) | NotebookLM's summary of every source — only generated if the optional [notebooklm skill](https://github.com/anthropics/skills) is installed locally |

## Optional: AI summary step

The script can ask NotebookLM to summarize every source after it finishes processing. This requires the local [notebooklm skill](https://github.com/anthropics/skills) installed at `~/.claude/skills/notebooklm/`.

**If you don't have the skill installed:** the summary step is automatically skipped. The notebook is still created with all your videos as sources — just open it in your browser to ask questions yourself.

**To skip the summary explicitly:**
```bash
SKIP_SUMMARY=1 npm start
```

## Tips

- **Watch Later size matters.** If you have 500+ videos, you'll get 10+ notebooks. NotebookLM caps at 50 sources per notebook on the free plan.
- **Processing time.** NotebookLM takes ~30s-2min per source to process YouTube videos. Be patient. The script polls every 5s and waits up to 20 minutes per batch.
- **First sign-in is interactive.** The script can't bypass Google's 2FA — you have to log in manually the first time. After that, the saved session lasts weeks/months.
- **Re-runs create NEW notebooks.** Each run is a fresh notebook (timestamped). To update an existing notebook, do that manually in NotebookLM.

## Why?

Watch Later is where YouTube videos go to die. Most people accumulate hundreds and never watch them. Loading them into NotebookLM lets you:
- Ask "Which of these are about X?"
- Get summaries without watching anything
- Search across the content of every video at once
- Decide which ones are actually worth watching

## License

MIT — your videos, your notebooks, your data.

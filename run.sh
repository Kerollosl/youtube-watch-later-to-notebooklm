#!/bin/zsh
cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
[[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

LOG="$HOME/Library/Logs/yt-watch-later.log"
echo "\n--- $(date) ---" >> "$LOG"

OUTPUT=$(npm start 2>&1)
STATUS=$?
echo "$OUTPUT" >> "$LOG"

if [ $STATUS -eq 0 ]; then
  URL=$(echo "$OUTPUT" | grep -Eo 'https://(notebook|notebooklm)\.google\.com/notebook/[^ ]*' | head -1)
  MSG=${URL:-"Done — check ~/Library/Logs/yt-watch-later.log"}
  osascript -e "display notification \"$MSG\" with title \"Watch Later → NotebookLM\" sound name \"Glass\""
else
  LAST=$(echo "$OUTPUT" | grep "Fatal:\|Error:" | tail -1)
  osascript -e "display notification \"${LAST:-See ~/Library/Logs/yt-watch-later.log}\" with title \"Watch Later Failed\" sound name \"Basso\""
fi

exit "$STATUS"

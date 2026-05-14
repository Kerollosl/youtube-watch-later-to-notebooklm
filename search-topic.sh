#!/bin/bash

# Quick launcher: prompts for topic, creates NotebookLM notebook with 35 videos, no playlist

# Load NVM so npm/node are available (Automator doesn't inherit shell PATH)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

# Prompt user for topic using macOS dialog
TOPIC=$(osascript -e 'tell app "System Events" to text returned of (display dialog "Enter topic to research:" default answer "" with title "NotebookLM Research" buttons {"Cancel", "Search"} default button 2)' 2>/dev/null)

# Check if user canceled
if [ $? -ne 0 ] || [ -z "$TOPIC" ]; then
    exit 1
fi

# Run the search with 35 videos max and skip playlist
npm run topic -- "$TOPIC" --max=35

# Show completion notification
osascript -e "display notification \"NotebookLM notebook created!\" with title \"Research Complete\" subtitle \"$TOPIC\""

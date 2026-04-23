#!/bin/bash
set -e

# Post-merge setup for OutreachAI
# Runs automatically after any task agent merge.
# No npm/node install needed — extension is vanilla JS, no build step.
# DB migrations are applied manually via supabase db query (migration history mismatch workaround).

echo "Post-merge setup complete."

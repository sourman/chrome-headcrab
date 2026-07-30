#!/usr/bin/env bash
# Minimal attach + title read. Requires Chrome remote debugging already enabled.
set -euo pipefail
chrome-headcrab attach --name demo
chrome-headcrab tabs --name demo | head
chrome-headcrab eval --name demo --page 'document.title'
echo "driver held — further evals will not re-prompt Allow"
echo "detach with: chrome-headcrab detach demo"

#!/usr/bin/env bash

# Build the MCP Zotero API plugin XPI

set -e

PLUGIN_NAME="mcp-zotero-api"

cd "$(dirname "$0")"

# Read version from manifest.json (single source of truth)
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)

# Remove old XPI if exists
rm -f "${PLUGIN_NAME}.xpi"

# Create XPI (which is just a ZIP with the files at the archive root)
zip -r "${PLUGIN_NAME}.xpi" \
    manifest.json \
    bootstrap.js \
    icon.svg \
    vendor

echo "Built ${PLUGIN_NAME}.xpi (v${VERSION})"
echo ""
echo "To install:"
echo "  1. Open Zotero"
echo "  2. Go to Tools → Add-ons"
echo "  3. Click the gear icon → Install Add-on From File..."
echo "  4. Select ${PLUGIN_NAME}.xpi"
echo "  5. Restart Zotero"
echo ""
echo "To release: create GitHub Release tag v${VERSION}, attach ${PLUGIN_NAME}.xpi,"
echo "and make sure updates.json lists v${VERSION}."

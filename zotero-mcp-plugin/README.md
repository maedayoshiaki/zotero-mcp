# MCP Zotero API Plugin

A Zotero 7/9 plugin that exposes, while Zotero is running:

1. A **native MCP server over HTTP** at `http://127.0.0.1:23119/mcp` — connect
   Claude Code directly, no external runtime required (recommended).
2. A **REST API** at `http://127.0.0.1:23119/mcp/...` for scripts/tools that
   prefer plain HTTP (curl/Python).

## Installation

1. Build the XPI: `./build.sh` (macOS/Linux) or `./build.ps1` (Windows)
2. In Zotero, go to **Tools → Add-ons**
3. Click the gear icon and select **Install Add-on From File...**
4. Select the `mcp-zotero-api.xpi` file
5. Restart Zotero

Released builds can be downloaded from the repository's GitHub Releases; once
installed, Zotero auto-updates the plugin via `updates.json`.

## MCP integration (Claude Code)

The plugin **is** an MCP server (Streamable HTTP, stateless). Register it in
Claude Code with one command — no Python, Node, or separate process:

```bash
claude mcp add --transport http zotero-local http://127.0.0.1:23119/mcp
claude mcp list        # zotero-local ... ✔ Connected
```

Claude then has these 20 tools:

- **Read:** `zotero_ping`, `zotero_search`, `zotero_lookup_citekey`,
  `zotero_get_item`, `zotero_get_children`, `zotero_list_items`,
  `zotero_read_pdf`, `zotero_pdf_outline`
- **Annotate:** `zotero_create_highlight`, `zotero_create_annotation`,
  `zotero_update_annotation`, `zotero_delete_annotations`
- **Organize:** `zotero_create_note`, `zotero_update_item`, `zotero_set_tags`,
  `zotero_set_collections`, `zotero_create_collection`, `zotero_add_attachment`
- **Delete:** `zotero_delete_items`, `zotero_delete_collection`

Zotero must be running (the server listens on `127.0.0.1:23119`).

> **PDF text & highlights are fully in-plugin (v1.5.0+):** `zotero_read_pdf`,
> `zotero_pdf_outline`, and `zotero_create_highlight` use a bundled copy of
> pdf.js (`vendor/`), so highlighting by search text works for **all pages** with
> no external tool. `zotero_create_highlight` finds the text on the page and
> computes the rectangles itself. (`zotero_create_annotation` still accepts an
> explicit `position: { pageIndex, rects }` for area/image annotations.)

The raw MCP endpoint accepts JSON-RPC (`initialize`, `tools/list`, `tools/call`,
`ping`). Everything below documents the underlying REST API those tools call.

## API Endpoints

All endpoints are available at `http://localhost:23119/mcp/...`

### GET /mcp/ping

Check if the plugin is active.

**Response:**
```json
{
  "status": "ok",
  "plugin": "mcp-zotero-api",
  "version": "1.0.0",
  "zoteroVersion": "7.0.x"
}
```

### POST /mcp/annotations

Create a new annotation on a PDF attachment.

**Request Body:**
```json
{
  "parentItemKey": "ABCD1234",
  "annotationType": "highlight",
  "text": "The highlighted text",
  "comment": "My note about this highlight",
  "color": "#ffd400",
  "pageLabel": "1",
  "sortIndex": "00000|000000|000000",
  "position": {
    "pageIndex": 0,
    "rects": [[100, 200, 300, 220]]
  }
}
```

**Required fields:**
- `parentItemKey`: The key of the PDF attachment item

**Optional fields:**
- `annotationType`: "highlight" (default), "note", "image", "ink", "underline"
- `text`: The text content of the annotation
- `comment`: A comment/note attached to the annotation
- `color`: Hex color code (default: "#ffd400" yellow)
- `pageLabel`: The page label/number
- `sortIndex`: Sort index for ordering
- `position`: Position data (JSON object)

**Response:**
```json
{
  "success": true,
  "annotation": {
    "id": 12345,
    "key": "WXYZ5678",
    "parentItemKey": "ABCD1234",
    "type": "highlight",
    "text": "The highlighted text",
    "color": "#ffd400",
    "pageLabel": "1"
  }
}
```

### GET /mcp/items?key=ABCD1234

Get item details by key.

**Response:**
```json
{
  "id": 123,
  "key": "ABCD1234",
  "itemType": "book",
  "title": "Example Book",
  "creators": [...],
  "attachments": [...]
}
```

### GET /mcp/search?q=query&limit=25

Search for items.

**Response:**
```json
{
  "results": [...],
  "total": 10
}
```

### GET /mcp/children?key=ABCD1234

Get child items (attachments, notes, annotations) for an item.

**Response:**
```json
{
  "parentKey": "ABCD1234",
  "children": [...]
}
```

## Usage with Python

```python
import requests
import json

BASE_URL = "http://localhost:23119"

# Check if plugin is active
response = requests.get(f"{BASE_URL}/mcp/ping")
print(response.json())

# Create a highlight annotation
annotation_data = {
    "parentItemKey": "PDF_ATTACHMENT_KEY",
    "annotationType": "highlight",
    "text": "Important text to highlight",
    "comment": "This is my note",
    "color": "#ffd400",
    "pageLabel": "1",
    "position": {
        "pageIndex": 0,
        "rects": [[100, 200, 300, 220]]
    }
}

response = requests.post(
    f"{BASE_URL}/mcp/annotations",
    headers={"Content-Type": "application/json"},
    data=json.dumps(annotation_data)
)
print(response.json())
```

## Development

The plugin is a bootstrapped Zotero 7 plugin using the standard WebExtension-style manifest.

### Files

- `manifest.json` - Plugin metadata and version (single source of truth)
- `bootstrap.js` - HTTP endpoint registration, REST handlers, and MCP layer
- `icon.svg` - Plugin icon
- `updates.json` - Zotero auto-update manifest (bump when releasing)

### Building

```bash
./build.sh        # macOS/Linux (needs `zip`)
./build.ps1       # Windows PowerShell (no `zip` needed)
```

This creates `mcp-zotero-api.xpi` which can be installed in Zotero.

### Releasing

1. Bump `version` in `manifest.json` and the matching entry in `updates.json`.
2. Build the XPI.
3. Create a GitHub Release tagged `vX.Y.Z` and attach `mcp-zotero-api.xpi`.
   The `update_link` in `updates.json` points at that release asset, so
   installed users auto-update.

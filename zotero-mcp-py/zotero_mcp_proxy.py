#!/usr/bin/env python3
"""
Zotero MCP proxy (lightweight, local-only)

A thin MCP server that exposes the mcp-zotero-api plugin's local HTTP API
(http://127.0.0.1:23119/mcp/*) as MCP tools, so that MCP clients WITHOUT a
shell tool (Claude Desktop) can drive Zotero the same way Claude Code does via
Bash+curl. PDF text extraction and highlight coordinate calculation are done
locally with PyMuPDF -- no cloud Web API is used, and every write is reflected
immediately in the running Zotero.

Architecture
    MCP client --(stdio)--> this proxy --(HTTP)--> mcp-zotero-api plugin --> Zotero
                                     `--(PyMuPDF, local file)

Requirements
    Zotero running with the mcp-zotero-api plugin (v1.3.0+) installed.
    pip install mcp pymupdf httpx

Config
    ZOTERO_URL   base URL of the plugin (default: http://127.0.0.1:23119/mcp)

The tool surface mirrors the plugin's 15 endpoints one-to-one, plus local
PyMuPDF helpers (read pages, outline, highlight coordinate calculation).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

# MCP uses stdout for JSON-RPC; keep third-party logging off stdout and quiet.
# (Python's logging defaults to stderr, so this only tames verbosity.)
logging.getLogger("httpx").setLevel(logging.WARNING)

try:  # PyMuPDF >= 1.24 ships the `pymupdf` top-level name; older uses `fitz`.
    import pymupdf
except ImportError:  # pragma: no cover
    import fitz as pymupdf  # type: ignore

from mcp.server.fastmcp import FastMCP

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

ZOTERO_URL = os.environ.get("ZOTERO_URL", "http://127.0.0.1:23119/mcp").rstrip("/")
HTTP_TIMEOUT = float(os.environ.get("ZOTERO_HTTP_TIMEOUT", "30"))

# Semantic color scheme (matches the project README). Callers may also pass a
# raw "#rrggbb" hex value, which is used verbatim.
SEMANTIC_COLORS = {
    "section1": "#2ea8e5",  # Blue   - primary organization
    "section2": "#a28ae5",  # Purple - secondary organization
    "section3": "#e56eee",  # Magenta- tertiary organization
    "positive": "#5fb236",  # Green  - agreement / support
    "detail": "#aaaaaa",    # Grey   - context / detail
    "negative": "#ff6666",  # Red    - criticism / disagreement
    "code": "#f19837",      # Orange - technical content
    "yellow": "#ffd400",    # Default Zotero yellow
}

mcp = FastMCP("zotero-local")
_client = httpx.Client(timeout=HTTP_TIMEOUT)


# --------------------------------------------------------------------------- #
# HTTP helpers
# --------------------------------------------------------------------------- #

def _get(path: str) -> Any:
    """GET {ZOTERO_URL}{path} and return parsed JSON, raising on plugin errors."""
    r = _client.get(f"{ZOTERO_URL}{path}")
    return _handle(r)


def _post(path: str, body: dict) -> Any:
    """POST JSON to {ZOTERO_URL}{path} and return parsed JSON."""
    r = _client.post(f"{ZOTERO_URL}{path}", json=body)
    return _handle(r)


def _handle(r: httpx.Response) -> Any:
    try:
        data = r.json()
    except Exception:
        r.raise_for_status()
        raise RuntimeError(f"Non-JSON response from Zotero plugin: {r.text[:200]}")
    # The plugin returns {"error": ...} with a 4xx/5xx status on failure.
    if r.status_code >= 400 or (isinstance(data, dict) and data.get("error")):
        msg = data.get("error") if isinstance(data, dict) else str(data)
        detail = data.get("message") if isinstance(data, dict) else ""
        raise RuntimeError(
            f"Zotero plugin error ({r.status_code}): {msg}"
            + (f" - {detail}" if detail else "")
        )
    return data


def _resolve_color(color: Optional[str]) -> Optional[str]:
    if not color:
        return None
    if color.startswith("#"):
        return color
    return SEMANTIC_COLORS.get(color.lower(), color)


def _resolve_pdf(attachment_or_item_key: str) -> tuple[str, str]:
    """
    Resolve a key to (attachment_key, local_pdf_path).

    Accepts either a PDF attachment key directly, or a regular item key (in
    which case its first PDF attachment is used).
    """
    item = _post("/item", {"key": attachment_or_item_key})
    # Direct attachment
    if item.get("itemType") == "attachment" and item.get("path"):
        return item["key"], item["path"]
    # Regular item -> find first PDF attachment
    for att in item.get("attachments", []) or []:
        if att.get("contentType") == "application/pdf" and att.get("path"):
            return att["key"], att["path"]
    raise RuntimeError(
        f"No PDF attachment with a local file path found for key "
        f"'{attachment_or_item_key}'. Pass the PDF attachment key directly."
    )


def _rects_to_zotero(rects: list, page_height: float) -> list[list[float]]:
    """
    Convert PyMuPDF rectangles (top-left origin, y grows downward) to
    Zotero/PDF rectangles (bottom-left origin, y grows upward) as
    [x1, y1, x2, y2] with y1 < y2. Mirrors search_for_rects() in the Rust
    client: new_y = page_height - old_y.
    """
    out = []
    for r in rects:
        x0, y0, x1, y1 = float(r.x0), float(r.y0), float(r.x1), float(r.y1)
        out.append([x0, page_height - y1, x1, page_height - y0])
    return out


def _parse_pages(spec: str, page_count: int) -> list[int]:
    """Parse a 1-based page spec like '1-10', '3', '1,3,5-7' -> 0-based indices."""
    indices: list[int] = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
        for p in range(start, end + 1):
            idx = p - 1
            if 0 <= idx < page_count and idx not in indices:
                indices.append(idx)
    return indices


# --------------------------------------------------------------------------- #
# Read tools (plugin endpoints + local PyMuPDF)
# --------------------------------------------------------------------------- #

@mcp.tool()
def zotero_ping() -> dict:
    """Health check. Confirms Zotero is running and the plugin is active."""
    return _get("/ping")


@mcp.tool()
def zotero_search(query: str, limit: int = 25) -> dict:
    """Search the Zotero library (quicksearch, all fields). Returns matching regular items."""
    return _post("/search", {"query": query, "limit": limit})


@mcp.tool()
def zotero_lookup_citekey(citekey: str) -> dict:
    """Look up an item by its BetterBibTeX citation key. Returns item metadata and PDF attachments."""
    return _post("/citekey", {"citekey": citekey})


@mcp.tool()
def zotero_get_item(key: str) -> dict:
    """Get full details of an item by its 8-char key (metadata, creators, attachments)."""
    return _post("/item", {"key": key})


@mcp.tool()
def zotero_get_children(key: str) -> dict:
    """Get child items of a key: attachments/notes for a regular item, or annotations for an attachment."""
    return _post("/children", {"key": key})


@mcp.tool()
def zotero_list_items(limit: int = 50) -> dict:
    """List top-level items in the library (excludes attachments/notes/annotations)."""
    return _post("/items", {"limit": limit})


@mcp.tool()
def zotero_read_pdf(key: str, pages: str, max_chars: int = 200000) -> dict:
    """
    Extract text from PDF pages locally with PyMuPDF (no cloud).

    key    : PDF attachment key, or a regular item key (its first PDF is used).
    pages  : 1-based page spec, e.g. "1-10", "3", or "1,3,5-7".
    Returns {attachment_key, page_count, pages: [{page, text}]}.
    """
    attachment_key, path = _resolve_pdf(key)
    doc = pymupdf.open(path)
    try:
        indices = _parse_pages(pages, doc.page_count)
        result = []
        total = 0
        for idx in indices:
            text = doc.load_page(idx).get_text()
            if total + len(text) > max_chars:
                text = text[: max(0, max_chars - total)]
                result.append({"page": idx + 1, "text": text, "truncated": True})
                break
            total += len(text)
            result.append({"page": idx + 1, "text": text})
        return {
            "attachment_key": attachment_key,
            "page_count": doc.page_count,
            "pages": result,
        }
    finally:
        doc.close()


@mcp.tool()
def zotero_pdf_outline(key: str) -> dict:
    """
    Get the PDF outline / table of contents (bookmarks) locally with PyMuPDF.
    Returns {attachment_key, page_count, outline: [{level, title, page}]}.
    """
    attachment_key, path = _resolve_pdf(key)
    doc = pymupdf.open(path)
    try:
        toc = doc.get_toc()  # [[level, title, page(1-based)], ...]
        outline = [{"level": lvl, "title": title, "page": page} for lvl, title, page in toc]
        return {
            "attachment_key": attachment_key,
            "page_count": doc.page_count,
            "outline": outline,
        }
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# Annotation tools
# --------------------------------------------------------------------------- #

@mcp.tool()
def zotero_create_highlight(
    key: str,
    text: str,
    page: int,
    color: str = "yellow",
    comment: Optional[str] = None,
) -> dict:
    """
    Create a highlight annotation on a PDF page.

    Finds `text` on 1-based `page` with PyMuPDF, computes Zotero-space
    rectangles (bottom-left origin), and posts the annotation. Use text that is
    UNIQUE on the page to avoid matching the wrong occurrence.

    key     : PDF attachment key (or item key; first PDF is used).
    text    : exact text to highlight (unique substring on the page).
    page    : 1-based page number.
    color   : semantic name (section1/section2/section3/positive/detail/
              negative/code/yellow) or a raw "#rrggbb" value.
    comment : optional note (e.g. a translation) attached to the highlight.
    """
    attachment_key, path = _resolve_pdf(key)
    doc = pymupdf.open(path)
    try:
        if not (1 <= page <= doc.page_count):
            raise RuntimeError(f"page {page} out of range (1..{doc.page_count})")
        pg = doc.load_page(page - 1)
        rects = pg.search_for(text)
        if not rects:
            raise RuntimeError(
                f"Text not found on page {page}. Use an exact, unique substring "
                f"(search is case- and whitespace-sensitive)."
            )
        page_height = float(pg.rect.height)
        zrects = _rects_to_zotero(rects, page_height)
    finally:
        doc.close()

    body: dict = {
        "parentItemKey": attachment_key,
        "annotationType": "highlight",
        "text": text,
        "color": _resolve_color(color) or SEMANTIC_COLORS["yellow"],
        "pageLabel": str(page),
        "position": {"pageIndex": page - 1, "rects": zrects},
    }
    if comment:
        body["comment"] = comment
    return _post("/annotations", body)


@mcp.tool()
def zotero_create_area_annotation(
    key: str,
    page: int,
    rect: list[float],
    color: str = "yellow",
    comment: Optional[str] = None,
) -> dict:
    """
    Create an area (image) annotation, e.g. around a figure.

    key   : PDF attachment key (or item key; first PDF is used).
    page  : 1-based page number.
    rect  : [x0, y0, x1, y1] in PyMuPDF top-left coordinates (as returned by
            search_for / rendering); it is flipped to Zotero bottom-left space.
    color : semantic name or "#rrggbb".
    comment: optional note.
    """
    attachment_key, path = _resolve_pdf(key)
    doc = pymupdf.open(path)
    try:
        if not (1 <= page <= doc.page_count):
            raise RuntimeError(f"page {page} out of range (1..{doc.page_count})")
        page_height = float(doc.load_page(page - 1).rect.height)
    finally:
        doc.close()

    x0, y0, x1, y1 = rect
    zrect = [x0, page_height - y1, x1, page_height - y0]
    body: dict = {
        "parentItemKey": attachment_key,
        "annotationType": "image",
        "color": _resolve_color(color) or SEMANTIC_COLORS["yellow"],
        "pageLabel": str(page),
        "position": {"pageIndex": page - 1, "rects": [zrect]},
    }
    if comment:
        body["comment"] = comment
    return _post("/annotations", body)


@mcp.tool()
def zotero_update_annotation(
    key: str,
    comment: Optional[str] = None,
    color: Optional[str] = None,
    text: Optional[str] = None,
    page_label: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> dict:
    """
    Update an existing annotation. Only provided fields are changed.
    `color` accepts a semantic name or "#rrggbb". `tags` replaces the tag set.
    """
    body: dict = {"key": key}
    if comment is not None:
        body["comment"] = comment
    if color is not None:
        body["color"] = _resolve_color(color)
    if text is not None:
        body["text"] = text
    if page_label is not None:
        body["pageLabel"] = str(page_label)
    if tags is not None:
        body["tags"] = tags
    return _post("/annotations/update", body)


@mcp.tool()
def zotero_delete_annotations(keys: list[str], permanent: bool = False) -> dict:
    """
    Delete annotation(s) by key. permanent=false moves them to Trash;
    permanent=true erases them entirely. Only annotation items are accepted.
    """
    return _post("/annotations/delete", {"keys": keys, "permanent": permanent})


# --------------------------------------------------------------------------- #
# Organize tools: notes, items, tags, collections, attachments
# --------------------------------------------------------------------------- #

@mcp.tool()
def zotero_create_note(
    note: str,
    parent_item_key: Optional[str] = None,
    tags: Optional[list[str]] = None,
    collections: Optional[list[str]] = None,
) -> dict:
    """
    Create a note (HTML/text). If parent_item_key is given it becomes a child
    note; otherwise a standalone note (collections apply only to standalone).
    """
    body: dict = {"note": note}
    if parent_item_key:
        body["parentItemKey"] = parent_item_key
    if tags:
        body["tags"] = tags
    if collections:
        body["collections"] = collections
    return _post("/notes", body)


@mcp.tool()
def zotero_update_item(
    key: str,
    fields: Optional[dict] = None,
    creators: Optional[list[dict]] = None,
    note: Optional[str] = None,
) -> dict:
    """
    Update an item. `fields` is a name->value map of item fields (invalid ones
    are skipped), `creators` is Zotero's creators JSON, `note` sets note content
    for note items.
    """
    body: dict = {"key": key}
    if fields is not None:
        body["fields"] = fields
    if creators is not None:
        body["creators"] = creators
    if note is not None:
        body["note"] = note
    return _post("/items/update", body)


@mcp.tool()
def zotero_set_tags(
    key: str,
    add: Optional[list[str]] = None,
    remove: Optional[list[str]] = None,
    replace: Optional[list[str]] = None,
) -> dict:
    """
    Modify tags on an item. Use `replace` to set the whole tag set, or
    `add`/`remove` for incremental changes.
    """
    body: dict = {"key": key}
    if add:
        body["add"] = add
    if remove:
        body["remove"] = remove
    if replace is not None:
        body["replace"] = replace
    return _post("/tags", body)


@mcp.tool()
def zotero_set_collections(
    key: str,
    add: Optional[list[str]] = None,
    remove: Optional[list[str]] = None,
) -> dict:
    """
    Add/remove an item to/from collections. Collections are referenced by
    8-char key or by name.
    """
    body: dict = {"key": key}
    if add:
        body["add"] = add
    if remove:
        body["remove"] = remove
    return _post("/collections", body)


@mcp.tool()
def zotero_create_collection(name: str, parent: Optional[str] = None) -> dict:
    """Create a new collection, optionally nested under `parent` (key or name)."""
    body: dict = {"name": name}
    if parent:
        body["parent"] = parent
    return _post("/collections/create", body)


@mcp.tool()
def zotero_delete_collection(spec: str, permanent: bool = False) -> dict:
    """
    Delete a collection by key or name. Items inside are NOT deleted.
    permanent=false trashes it; permanent=true erases it.
    """
    return _post("/collections/delete", {"key": spec, "permanent": permanent})


@mcp.tool()
def zotero_add_attachment(
    parent_item_key: Optional[str] = None,
    path: Optional[str] = None,
    url: Optional[str] = None,
    title: Optional[str] = None,
    link_mode: Optional[str] = None,
    content_type: Optional[str] = None,
) -> dict:
    """
    Add an attachment. Provide either a local `path` or a `url`.
    link_mode: imported_file | linked_file | imported_url | linked_url
    (defaults to imported_file for path, linked_url for url).
    """
    if not path and not url:
        raise RuntimeError("Provide either 'path' (a local file) or 'url'.")
    body: dict = {}
    if parent_item_key:
        body["parentItemKey"] = parent_item_key
    if path:
        body["path"] = path
    if url:
        body["url"] = url
    if title:
        body["title"] = title
    if link_mode:
        body["linkMode"] = link_mode
    if content_type:
        body["contentType"] = content_type
    return _post("/attachments", body)


@mcp.tool()
def zotero_delete_items(keys: list[str], permanent: bool = False) -> dict:
    """
    Delete item(s) of any type (regular item, note, attachment, annotation) by
    key. permanent=false trashes; permanent=true erases entirely.
    """
    return _post("/items/delete", {"keys": keys, "permanent": permanent})


# --------------------------------------------------------------------------- #

def main() -> None:
    mcp.run()  # stdio transport


if __name__ == "__main__":
    main()

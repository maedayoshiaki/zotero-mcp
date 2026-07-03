/**
 * MCP Zotero API Plugin
 * 
 * This plugin exposes HTTP endpoints for external tools (like MCP servers)
 * to create annotations and modify Zotero items while Zotero is running.
 * 
 * Endpoints:
 *   GET  /mcp/ping              - Check if the plugin is active
 *   POST /mcp/annotations       - Create a new annotation
 *   POST /mcp/items             - Get item details by key
 *   POST /mcp/search            - Search for items
 *   POST /mcp/children          - Get child items
 *   POST /mcp/annotations/delete - Trash or permanently delete annotation(s)
 *   POST /mcp/annotations/update - Update an existing annotation
 *   POST /mcp/notes             - Create a note item (child or standalone)
 *   POST /mcp/items/update      - Update item fields / creators / note content
 *   POST /mcp/tags              - Add / remove / replace tags on an item
 *   POST /mcp/collections       - Add / remove an item to / from collections
 *   POST /mcp/collections/create - Create a new collection
 *   POST /mcp/attachments       - Add an attachment (file import/link or URL)
 */

var MCP_Zotero;

function log(msg) {
    Zotero.debug("[MCP-Zotero] " + msg);
}

// Parse a request body that Zotero may hand us as an object or a (possibly
// URL-encoded) JSON string. Throws on invalid JSON.
function parseBody(requestData) {
    if (typeof requestData === 'object' && requestData !== null) {
        return requestData;
    }
    if (typeof requestData === 'string' && requestData.length) {
        let s = requestData;
        if (s.startsWith('%')) {
            s = decodeURIComponent(s);
        }
        return JSON.parse(s);
    }
    return {};
}

// Resolve a collection in the user library by 8-char key or by name.
function resolveCollection(spec) {
    let libraryID = Zotero.Libraries.userLibraryID;
    let all = Zotero.Collections.getByLibrary(libraryID, true);
    for (let c of all) {
        if (c.key === spec || c.name === spec) {
            return c;
        }
    }
    return null;
}

function install(data, reason) {
    log("Plugin installed");
}

function uninstall(data, reason) {
    log("Plugin uninstalled");
}

async function startup({ id, version, rootURI }, reason) {
    log("Starting MCP Zotero API plugin v" + version);
    
    // Wait for Zotero to be ready
    await Zotero.uiReadyPromise;
    
    // Initialize the MCP endpoints
    MCP_Zotero = {
        id,
        version,
        rootURI,
        endpoints: {}
    };
    
    // Register HTTP endpoints
    registerEndpoints();
    
    log("MCP Zotero API plugin started successfully");
}

function shutdown({ id, version, rootURI }, reason) {
    log("Shutting down MCP Zotero API plugin");
    
    // Unregister endpoints
    if (MCP_Zotero && MCP_Zotero.endpoints) {
        for (let path in MCP_Zotero.endpoints) {
            try {
                delete Zotero.Server.Endpoints[path];
                log("Unregistered endpoint: " + path);
            } catch (e) {
                log("Error unregistering endpoint " + path + ": " + e);
            }
        }
    }
    
    MCP_Zotero = null;
    log("MCP Zotero API plugin shut down");
}

function registerEndpoints() {
    // Ping endpoint - check if plugin is active
    registerEndpoint("/mcp/ping", {
        supportedMethods: ["GET"],
        supportedDataTypes: ["application/json"],
        init: function(data, sendResponseCallback) {
            sendResponseCallback(200, "application/json", JSON.stringify({
                status: "ok",
                plugin: "mcp-zotero-api",
                version: MCP_Zotero.version,
                zoteroVersion: Zotero.version
            }));
        }
    });
    
    // Create annotation endpoint
    registerEndpoint("/mcp/annotations", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                // Zotero already parses JSON for us
                if (typeof requestData === 'object' && requestData !== null) {
                    data = requestData;
                } else if (typeof requestData === 'string') {
                    try {
                        if (requestData.startsWith('%')) {
                            requestData = decodeURIComponent(requestData);
                        }
                        data = JSON.parse(requestData);
                    } catch (e) {
                        sendResponseCallback(400, "application/json", JSON.stringify({
                            error: "Invalid JSON",
                            message: e.message
                        }));
                        return;
                    }
                } else {
                    data = {};
                }
                
                // Validate required fields
                if (!data.parentItemKey) {
                    sendResponseCallback(400, "application/json", JSON.stringify({
                        error: "Missing required field: parentItemKey"
                    }));
                    return;
                }
                
                if (!data.annotationType) {
                    data.annotationType = "highlight";
                }
                
                // Find the parent item (should be a PDF attachment)
                let parentItem = await Zotero.Items.getByLibraryAndKeyAsync(
                    Zotero.Libraries.userLibraryID,
                    data.parentItemKey
                );
                
                if (!parentItem) {
                    sendResponseCallback(404, "application/json", JSON.stringify({
                        error: "Parent item not found",
                        key: data.parentItemKey
                    }));
                    return;
                }
                
                // Create the annotation
                let annotation = new Zotero.Item('annotation');
                annotation.libraryID = parentItem.libraryID;
                annotation.parentID = parentItem.id;
                
                // Set annotation properties
                annotation.annotationType = data.annotationType;
                
                if (data.text) {
                    annotation.annotationText = data.text;
                }
                
                if (data.comment) {
                    annotation.annotationComment = data.comment;
                }
                
                if (data.color) {
                    annotation.annotationColor = data.color;
                } else {
                    annotation.annotationColor = "#ffd400"; // Default yellow
                }
                
                if (data.pageLabel) {
                    annotation.annotationPageLabel = String(data.pageLabel);
                }
                
                // sortIndex is required - generate one if not provided
                // Format: NNNNN|NNNNNN|NNNNN (pageIndex|charOffset|charLength in padded format)
                if (data.sortIndex) {
                    annotation.annotationSortIndex = data.sortIndex;
                } else {
                    // Generate a default sortIndex based on page
                    let pageIdx = 0;
                    if (data.position && typeof data.position === 'object' && data.position.pageIndex !== undefined) {
                        pageIdx = data.position.pageIndex;
                    } else if (data.pageLabel) {
                        pageIdx = parseInt(data.pageLabel) - 1 || 0;
                    }
                    // Format: 5 digits for page | 6 digits for offset | 5 digits
                    annotation.annotationSortIndex = String(pageIdx).padStart(5, '0') + "|000000|00000";
                }
                
                if (data.position) {
                    // Position should be a JSON string or object
                    if (typeof data.position === 'object') {
                        annotation.annotationPosition = JSON.stringify(data.position);
                    } else {
                        annotation.annotationPosition = data.position;
                    }
                }
                
                // Save the annotation
                await annotation.saveTx();
                
                log("Created annotation: " + annotation.key + " on item " + data.parentItemKey);
                
                sendResponseCallback(201, "application/json", JSON.stringify({
                    success: true,
                    annotation: {
                        id: annotation.id,
                        key: annotation.key,
                        parentItemKey: data.parentItemKey,
                        type: annotation.annotationType,
                        text: annotation.annotationText,
                        color: annotation.annotationColor,
                        pageLabel: annotation.annotationPageLabel
                    }
                }));
                
            } catch (e) {
                log("Error creating annotation: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({
                    error: "Internal error",
                    message: e.message
                }));
            }
        }
    });
    
    // Get item by key endpoint (POST to pass JSON body)
    registerEndpoint("/mcp/item", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                if (typeof requestData === 'object' && requestData !== null) {
                    data = requestData;
                } else if (typeof requestData === 'string') {
                    try {
                        data = JSON.parse(requestData);
                    } catch (e) {
                        sendResponseCallback(400, "application/json", JSON.stringify({
                            error: "Invalid JSON",
                            message: e.message
                        }));
                        return;
                    }
                } else {
                    data = {};
                }
                
                let key = data.key;
                
                if (!key) {
                    sendResponseCallback(400, "application/json", JSON.stringify({
                        error: "Missing required field: key"
                    }));
                    return;
                }
                
                let item = await Zotero.Items.getByLibraryAndKeyAsync(
                    Zotero.Libraries.userLibraryID,
                    key
                );
                
                if (!item) {
                    sendResponseCallback(404, "application/json", JSON.stringify({
                        error: "Item not found",
                        key: key
                    }));
                    return;
                }
                
                let itemData = {
                    id: item.id,
                    key: item.key,
                    itemType: item.itemType,
                    title: item.getField('title'),
                    dateAdded: item.dateAdded,
                    dateModified: item.dateModified
                };
                
                // Add type-specific fields
                if (item.isRegularItem()) {
                    itemData.creators = item.getCreatorsJSON();
                    itemData.date = item.getField('date');
                    itemData.abstractNote = item.getField('abstractNote');
                    itemData.url = item.getField('url');
                    itemData.DOI = item.getField('DOI');
                    itemData.extra = item.getField('extra');
                    
                    // Get attachments
                    let attachmentIDs = item.getAttachments();
                    itemData.attachments = [];
                    for (let attID of attachmentIDs) {
                        let att = await Zotero.Items.getAsync(attID);
                        itemData.attachments.push({
                            id: att.id,
                            key: att.key,
                            title: att.getField('title'),
                            contentType: att.attachmentContentType,
                            path: att.getFilePath()
                        });
                    }
                }
                
                if (item.isAttachment()) {
                    itemData.contentType = item.attachmentContentType;
                    itemData.path = item.getFilePath();
                    itemData.parentItemID = item.parentItemID;
                }
                
                sendResponseCallback(200, "application/json", JSON.stringify(itemData));
                
            } catch (e) {
                log("Error getting item: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({
                    error: "Internal error",
                    message: e.message
                }));
            }
        }
    });
    
    // Search items endpoint (POST to pass JSON body)
    registerEndpoint("/mcp/search", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                log("search received type: " + typeof requestData);
                let data;
                // Zotero already parses JSON for us
                if (typeof requestData === 'object' && requestData !== null) {
                    data = requestData;
                } else if (typeof requestData === 'string') {
                    try {
                        if (requestData.startsWith('%')) {
                            requestData = decodeURIComponent(requestData);
                        }
                        data = JSON.parse(requestData);
                    } catch (e) {
                        sendResponseCallback(400, "application/json", JSON.stringify({
                            error: "Invalid JSON",
                            message: e.message
                        }));
                        return;
                    }
                } else {
                    data = {};
                }
                
                let query = data.query || data.q;
                let limit = parseInt(data.limit) || 25;
                
                if (!query) {
                    sendResponseCallback(400, "application/json", JSON.stringify({
                        error: "Missing required field: query"
                    }));
                    return;
                }
                
                let s = new Zotero.Search();
                s.libraryID = Zotero.Libraries.userLibraryID;
                s.addCondition('quicksearch-everything', 'contains', query);
                
                let ids = await s.search();
                ids = ids.slice(0, limit);
                
                let items = await Zotero.Items.getAsync(ids);
                let results = [];
                
                for (let item of items) {
                    if (item.isRegularItem()) {
                        results.push({
                            id: item.id,
                            key: item.key,
                            itemType: item.itemType,
                            title: item.getField('title'),
                            creators: item.getCreatorsJSON(),
                            date: item.getField('date'),
                            extra: item.getField('extra')
                        });
                    }
                }
                
                sendResponseCallback(200, "application/json", JSON.stringify({
                    results: results,
                    total: results.length
                }));
                
            } catch (e) {
                log("Error searching items: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({
                    error: "Internal error",
                    message: e.message
                }));
            }
        }
    });
    
    // Get item children (attachments, notes, annotations)
    registerEndpoint("/mcp/children", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                if (typeof requestData === 'object' && requestData !== null) {
                    data = requestData;
                } else if (typeof requestData === 'string') {
                    try {
                        data = JSON.parse(requestData);
                    } catch (e) {
                        sendResponseCallback(400, "application/json", JSON.stringify({
                            error: "Invalid JSON",
                            message: e.message
                        }));
                        return;
                    }
                } else {
                    data = {};
                }
                
                let key = data.key;
                
                if (!key) {
                    sendResponseCallback(400, "application/json", JSON.stringify({
                        error: "Missing required field: key"
                    }));
                    return;
                }
                
                let item = await Zotero.Items.getByLibraryAndKeyAsync(
                    Zotero.Libraries.userLibraryID,
                    key
                );
                
                if (!item) {
                    sendResponseCallback(404, "application/json", JSON.stringify({
                        error: "Item not found",
                        key: key
                    }));
                    return;
                }
                
                let children = [];
                
                // Get attachments
                if (item.isRegularItem()) {
                    let attachmentIDs = item.getAttachments();
                    for (let attID of attachmentIDs) {
                        let att = await Zotero.Items.getAsync(attID);
                        children.push({
                            id: att.id,
                            key: att.key,
                            itemType: 'attachment',
                            title: att.getField('title'),
                            contentType: att.attachmentContentType,
                            path: att.getFilePath()
                        });
                    }
                    
                    // Get notes
                    let noteIDs = item.getNotes();
                    for (let noteID of noteIDs) {
                        let note = await Zotero.Items.getAsync(noteID);
                        children.push({
                            id: note.id,
                            key: note.key,
                            itemType: 'note',
                            note: note.getNote()
                        });
                    }
                }
                
                // If it's an attachment, get annotations
                if (item.isAttachment()) {
                    let annotations = item.getAnnotations();
                    for (let ann of annotations) {
                        children.push({
                            id: ann.id,
                            key: ann.key,
                            itemType: 'annotation',
                            annotationType: ann.annotationType,
                            text: ann.annotationText,
                            comment: ann.annotationComment,
                            color: ann.annotationColor,
                            pageLabel: ann.annotationPageLabel,
                            sortIndex: ann.annotationSortIndex,
                            position: ann.annotationPosition
                        });
                    }
                }
                
                sendResponseCallback(200, "application/json", JSON.stringify({
                    parentKey: key,
                    children: children
                }));
                
            } catch (e) {
                log("Error getting children: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({
                    error: "Internal error",
                    message: e.message
                }));
            }
        }
    });
    
    // Get all top-level items
    registerEndpoint("/mcp/items", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data = {};
                if (typeof requestData === 'object' && requestData !== null) {
                    data = requestData;
                } else if (typeof requestData === 'string' && requestData) {
                    try {
                        data = JSON.parse(requestData);
                    } catch (e) {
                        // Ignore parse errors, use defaults
                    }
                }
                
                let limit = parseInt(data.limit) || 50;
                
                let s = new Zotero.Search();
                s.libraryID = Zotero.Libraries.userLibraryID;
                s.addCondition('itemType', 'isNot', 'attachment');
                s.addCondition('itemType', 'isNot', 'note');
                s.addCondition('itemType', 'isNot', 'annotation');
                
                let ids = await s.search();
                ids = ids.slice(0, limit);
                
                let items = await Zotero.Items.getAsync(ids);
                let results = [];
                
                for (let item of items) {
                    results.push({
                        id: item.id,
                        key: item.key,
                        itemType: item.itemType,
                        title: item.getField('title'),
                        creators: item.getCreatorsJSON(),
                        date: item.getField('date'),
                        extra: item.getField('extra')
                    });
                }
                
                sendResponseCallback(200, "application/json", JSON.stringify({
                    items: results,
                    total: results.length
                }));
                
            } catch (e) {
                log("Error getting items: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({
                    error: "Internal error",
                    message: e.message
                }));
            }
        }
    });
    
    // Lookup item by BetterBibTeX citation key
    registerEndpoint("/mcp/citekey", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                if (typeof requestData === 'object' && requestData !== null) {
                    data = requestData;
                } else if (typeof requestData === 'string') {
                    try {
                        data = JSON.parse(requestData);
                    } catch (e) {
                        sendResponseCallback(400, "application/json", JSON.stringify({
                            error: "Invalid JSON",
                            message: e.message
                        }));
                        return;
                    }
                } else {
                    data = {};
                }
                
                let citekey = data.citekey;
                
                if (!citekey) {
                    sendResponseCallback(400, "application/json", JSON.stringify({
                        error: "Missing required field: citekey"
                    }));
                    return;
                }
                
                // Call BetterBibTeX's JSON-RPC API to search by citekey
                let item = null;
                
                try {
                    // Use fetch to call BBT's JSON-RPC endpoint
                    let response = await fetch('http://127.0.0.1:23119/better-bibtex/json-rpc', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0',
                            method: 'item.search',
                            params: [citekey],
                            id: 1
                        })
                    });
                    
                    if (response.ok) {
                        let result = await response.json();
                        if (result.result && result.result.length > 0) {
                            // Extract the item key from the ID URL
                            // Format: "http://zotero.org/users/XXXXX/items/ITEMKEY"
                            let idUrl = result.result[0].id;
                            let itemKey = idUrl.split('/').pop();
                            
                            item = await Zotero.Items.getByLibraryAndKeyAsync(
                                Zotero.Libraries.userLibraryID,
                                itemKey
                            );
                        }
                    }
                } catch (e) {
                    log("BetterBibTeX JSON-RPC lookup failed: " + e);
                }
                
                // Fallback: search in extra field
                if (!item) {
                    let s = new Zotero.Search();
                    s.libraryID = Zotero.Libraries.userLibraryID;
                    s.addCondition('itemType', 'isNot', 'attachment');
                    s.addCondition('itemType', 'isNot', 'note');
                    s.addCondition('itemType', 'isNot', 'annotation');
                    
                    let ids = await s.search();
                    let items = await Zotero.Items.getAsync(ids);
                    
                    for (let it of items) {
                        let extra = it.getField('extra') || '';
                        if (extra.includes('Citation Key: ' + citekey) || 
                            extra.toLowerCase().includes('citekey: ' + citekey.toLowerCase())) {
                            item = it;
                            break;
                        }
                    }
                }
                
                if (!item) {
                    sendResponseCallback(404, "application/json", JSON.stringify({
                        error: "Item not found for citekey",
                        citekey: citekey
                    }));
                    return;
                }
                
                // Build response with item data
                let itemData = {
                    id: item.id,
                    key: item.key,
                    itemType: item.itemType,
                    title: item.getField('title'),
                    creators: item.getCreatorsJSON(),
                    date: item.getField('date'),
                    extra: item.getField('extra'),
                    citekey: citekey
                };
                
                // Get PDF attachments
                let attachmentIDs = item.getAttachments();
                itemData.attachments = [];
                for (let attID of attachmentIDs) {
                    let att = await Zotero.Items.getAsync(attID);
                    if (att.attachmentContentType === 'application/pdf') {
                        itemData.attachments.push({
                            id: att.id,
                            key: att.key,
                            title: att.getField('title'),
                            contentType: att.attachmentContentType,
                            path: att.getFilePath()
                        });
                    }
                }
                
                sendResponseCallback(200, "application/json", JSON.stringify(itemData));
                
            } catch (e) {
                log("Error looking up citekey: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({
                    error: "Internal error",
                    message: e.message
                }));
            }
        }
    });
    
    // Delete or trash annotation(s) by key
    registerEndpoint("/mcp/annotations/delete", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                // Zotero already parses JSON for us
                if (typeof requestData === 'object' && requestData !== null) {
                    data = requestData;
                } else if (typeof requestData === 'string') {
                    try {
                        if (requestData.startsWith('%')) {
                            requestData = decodeURIComponent(requestData);
                        }
                        data = JSON.parse(requestData);
                    } catch (e) {
                        sendResponseCallback(400, "application/json", JSON.stringify({
                            error: "Invalid JSON",
                            message: e.message
                        }));
                        return;
                    }
                } else {
                    data = {};
                }

                // Accept a single key or an array of keys
                let keys = [];
                if (Array.isArray(data.keys)) {
                    keys = data.keys;
                } else if (data.key) {
                    keys = [data.key];
                }

                if (!keys.length) {
                    sendResponseCallback(400, "application/json", JSON.stringify({
                        error: "Missing required field: key or keys"
                    }));
                    return;
                }

                // permanent: true -> erase entirely; otherwise move to Trash
                let permanent = data.permanent === true;

                let deleted = [];
                let notFound = [];
                let skipped = [];

                for (let key of keys) {
                    let item = await Zotero.Items.getByLibraryAndKeyAsync(
                        Zotero.Libraries.userLibraryID,
                        key
                    );
                    if (!item) {
                        notFound.push(key);
                        continue;
                    }
                    // Only allow deleting annotation items via this endpoint
                    if (!item.isAnnotation()) {
                        skipped.push(key);
                        continue;
                    }
                    if (permanent) {
                        await item.eraseTx();
                    } else {
                        item.deleted = true;
                        await item.saveTx();
                    }
                    deleted.push(key);
                }

                log("Deleted annotations (" + (permanent ? "erased" : "trashed") + "): " + deleted.join(", "));

                sendResponseCallback(200, "application/json", JSON.stringify({
                    success: true,
                    mode: permanent ? "erased" : "trashed",
                    deleted: deleted,
                    notFound: notFound,
                    skipped: skipped
                }));

            } catch (e) {
                log("Error deleting annotation: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({
                    error: "Internal error",
                    message: e.message
                }));
            }
        }
    });

    // Update an existing annotation (comment, color, text, pageLabel, position, tags)
    registerEndpoint("/mcp/annotations/update", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                try { data = parseBody(requestData); }
                catch (e) { return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Invalid JSON", message: e.message })); }

                if (!data.key) {
                    return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Missing required field: key" }));
                }
                let item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, data.key);
                if (!item) return sendResponseCallback(404, "application/json", JSON.stringify({ error: "Annotation not found", key: data.key }));
                if (!item.isAnnotation()) return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Item is not an annotation", key: data.key }));

                if (data.comment !== undefined) item.annotationComment = data.comment;
                if (data.color !== undefined) item.annotationColor = data.color;
                if (data.text !== undefined) item.annotationText = data.text;
                if (data.pageLabel !== undefined) item.annotationPageLabel = String(data.pageLabel);
                if (data.sortIndex !== undefined) item.annotationSortIndex = data.sortIndex;
                if (data.position !== undefined) {
                    item.annotationPosition = (typeof data.position === 'object') ? JSON.stringify(data.position) : data.position;
                }
                if (Array.isArray(data.tags)) {
                    item.setTags(data.tags.map(function(t) { return (typeof t === 'string') ? { tag: t } : t; }));
                }

                await item.saveTx();
                log("Updated annotation: " + item.key);
                sendResponseCallback(200, "application/json", JSON.stringify({
                    success: true,
                    annotation: { key: item.key, type: item.annotationType, color: item.annotationColor, comment: item.annotationComment, pageLabel: item.annotationPageLabel }
                }));
            } catch (e) {
                log("Error updating annotation: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({ error: "Internal error", message: e.message }));
            }
        }
    });

    // Create a note item (child of an item, or standalone), with optional tags/collections
    registerEndpoint("/mcp/notes", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                try { data = parseBody(requestData); }
                catch (e) { return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Invalid JSON", message: e.message })); }

                if (!data.note) {
                    return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Missing required field: note" }));
                }

                let libraryID = Zotero.Libraries.userLibraryID;
                let note = new Zotero.Item('note');
                note.libraryID = libraryID;

                if (data.parentItemKey) {
                    let parent = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, data.parentItemKey);
                    if (!parent) {
                        return sendResponseCallback(404, "application/json", JSON.stringify({ error: "Parent item not found", key: data.parentItemKey }));
                    }
                    note.parentID = parent.id;
                }

                note.setNote(String(data.note));

                if (Array.isArray(data.tags)) {
                    for (let t of data.tags) { note.addTag(typeof t === 'string' ? t : t.tag); }
                }

                await note.saveTx();

                // Collections only apply to a top-level (standalone) note
                if (!data.parentItemKey && Array.isArray(data.collections) && data.collections.length) {
                    for (let spec of data.collections) {
                        let col = resolveCollection(spec);
                        if (col) note.addToCollection(col.id);
                    }
                    await note.saveTx();
                }

                log("Created note: " + note.key);
                sendResponseCallback(201, "application/json", JSON.stringify({
                    success: true,
                    note: { id: note.id, key: note.key, parentItemKey: data.parentItemKey || null }
                }));
            } catch (e) {
                log("Error creating note: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({ error: "Internal error", message: e.message }));
            }
        }
    });

    // Update item fields / creators, and note content for note items
    registerEndpoint("/mcp/items/update", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                try { data = parseBody(requestData); }
                catch (e) { return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Invalid JSON", message: e.message })); }

                if (!data.key) {
                    return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Missing required field: key" }));
                }
                let item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, data.key);
                if (!item) return sendResponseCallback(404, "application/json", JSON.stringify({ error: "Item not found", key: data.key }));

                let applied = [];
                let skipped = [];

                if (data.note !== undefined && item.isNote()) {
                    item.setNote(String(data.note));
                    applied.push("note");
                }

                if (data.fields && typeof data.fields === 'object') {
                    for (let name in data.fields) {
                        try {
                            let fieldID = Zotero.ItemFields.getID(name);
                            if (fieldID && Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) {
                                item.setField(name, data.fields[name]);
                                applied.push(name);
                            } else {
                                skipped.push(name);
                            }
                        } catch (fe) {
                            skipped.push(name);
                        }
                    }
                }

                if (Array.isArray(data.creators)) {
                    item.setCreators(data.creators);
                    applied.push("creators");
                }

                await item.saveTx();
                log("Updated item " + item.key + " (" + applied.join(", ") + ")");
                sendResponseCallback(200, "application/json", JSON.stringify({
                    success: true, key: item.key, applied: applied, skipped: skipped
                }));
            } catch (e) {
                log("Error updating item: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({ error: "Internal error", message: e.message }));
            }
        }
    });

    // Add / remove / replace tags on an item
    registerEndpoint("/mcp/tags", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                try { data = parseBody(requestData); }
                catch (e) { return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Invalid JSON", message: e.message })); }

                if (!data.key) {
                    return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Missing required field: key" }));
                }
                let item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, data.key);
                if (!item) return sendResponseCallback(404, "application/json", JSON.stringify({ error: "Item not found", key: data.key }));

                let norm = function(t) { return (typeof t === 'string') ? t : t.tag; };

                if (Array.isArray(data.replace)) {
                    item.setTags(data.replace.map(function(t) { return { tag: norm(t) }; }));
                }
                if (Array.isArray(data.add)) {
                    for (let t of data.add) item.addTag(norm(t));
                }
                if (Array.isArray(data.remove)) {
                    for (let t of data.remove) item.removeTag(norm(t));
                }

                await item.saveTx();
                log("Updated tags on " + item.key);
                sendResponseCallback(200, "application/json", JSON.stringify({
                    success: true, key: item.key, tags: item.getTags().map(function(t) { return t.tag; })
                }));
            } catch (e) {
                log("Error updating tags: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({ error: "Internal error", message: e.message }));
            }
        }
    });

    // Add / remove an item to / from collections (by key or name)
    registerEndpoint("/mcp/collections", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                try { data = parseBody(requestData); }
                catch (e) { return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Invalid JSON", message: e.message })); }

                if (!data.key) {
                    return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Missing required field: key" }));
                }
                let item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, data.key);
                if (!item) return sendResponseCallback(404, "application/json", JSON.stringify({ error: "Item not found", key: data.key }));

                let added = [], removed = [], notFound = [];

                if (Array.isArray(data.add)) {
                    for (let spec of data.add) {
                        let col = resolveCollection(spec);
                        if (col) { item.addToCollection(col.id); added.push(col.key); }
                        else notFound.push(spec);
                    }
                }
                if (Array.isArray(data.remove)) {
                    for (let spec of data.remove) {
                        let col = resolveCollection(spec);
                        if (col) { item.removeFromCollection(col.id); removed.push(col.key); }
                        else notFound.push(spec);
                    }
                }

                await item.saveTx();
                log("Updated collections on " + item.key);
                sendResponseCallback(200, "application/json", JSON.stringify({
                    success: true, key: item.key, added: added, removed: removed, notFound: notFound
                }));
            } catch (e) {
                log("Error updating collections: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({ error: "Internal error", message: e.message }));
            }
        }
    });

    // Create a new collection (optionally nested under a parent key/name)
    registerEndpoint("/mcp/collections/create", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                try { data = parseBody(requestData); }
                catch (e) { return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Invalid JSON", message: e.message })); }

                if (!data.name) {
                    return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Missing required field: name" }));
                }
                let col = new Zotero.Collection();
                col.libraryID = Zotero.Libraries.userLibraryID;
                col.name = String(data.name);
                if (data.parent) {
                    let parent = resolveCollection(data.parent);
                    if (parent) col.parentID = parent.id;
                }
                await col.saveTx();
                log("Created collection: " + col.key + " (" + col.name + ")");
                sendResponseCallback(201, "application/json", JSON.stringify({
                    success: true, collection: { key: col.key, name: col.name }
                }));
            } catch (e) {
                log("Error creating collection: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({ error: "Internal error", message: e.message }));
            }
        }
    });

    // Add an attachment: import a file, link a file, or link/import a URL
    registerEndpoint("/mcp/attachments", {
        supportedMethods: ["POST"],
        supportedDataTypes: ["application/json", "text/plain"],
        init: async function(requestData, sendResponseCallback) {
            try {
                let data;
                try { data = parseBody(requestData); }
                catch (e) { return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Invalid JSON", message: e.message })); }

                let libraryID = Zotero.Libraries.userLibraryID;
                let parentItemID = null;
                if (data.parentItemKey) {
                    let parent = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, data.parentItemKey);
                    if (!parent) return sendResponseCallback(404, "application/json", JSON.stringify({ error: "Parent item not found", key: data.parentItemKey }));
                    parentItemID = parent.id;
                }

                let att = null;
                let mode = data.linkMode || (data.url ? "linked_url" : "imported_file");

                if (data.url) {
                    if (mode === "imported_url") {
                        att = await Zotero.Attachments.importFromURL({ url: data.url, parentItemID: parentItemID, libraryID: libraryID, title: data.title });
                    } else {
                        att = await Zotero.Attachments.linkFromURL({ url: data.url, parentItemID: parentItemID, title: data.title, contentType: data.contentType });
                    }
                } else if (data.path) {
                    let file = Zotero.File.pathToFile(data.path);
                    if (mode === "linked_file") {
                        att = await Zotero.Attachments.linkFromFile({ file: file, parentItemID: parentItemID, title: data.title });
                    } else {
                        att = await Zotero.Attachments.importFromFile({ file: file, parentItemID: parentItemID, libraryID: libraryID, title: data.title, contentType: data.contentType });
                    }
                } else {
                    return sendResponseCallback(400, "application/json", JSON.stringify({ error: "Provide either 'path' (a local file) or 'url'" }));
                }

                log("Created attachment: " + att.key + " mode=" + mode);
                sendResponseCallback(201, "application/json", JSON.stringify({
                    success: true,
                    attachment: { id: att.id, key: att.key, title: att.getField('title'), contentType: att.attachmentContentType, mode: mode }
                }));
            } catch (e) {
                log("Error creating attachment: " + e);
                sendResponseCallback(500, "application/json", JSON.stringify({ error: "Internal error", message: e.message }));
            }
        }
    });

    log("Registered " + Object.keys(MCP_Zotero.endpoints).length + " MCP endpoints");
}

function registerEndpoint(path, handler) {
    Zotero.Server.Endpoints[path] = function() {};
    Zotero.Server.Endpoints[path].prototype = handler;
    MCP_Zotero.endpoints[path] = true;
    log("Registered endpoint: " + path);
}

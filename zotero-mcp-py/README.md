# zotero-mcp-py — 軽量 Python MCP プロキシ

Zotero プラグイン (`mcp-zotero-api`) のローカル HTTP API を **MCP ツール**として
公開する薄いブリッジです。シェル実行ツールを持たない **Claude Desktop** でも、
Claude Code の「方法A(Bash+curl)」と同じ操作(読む/注釈/整理/編集/削除)が
できるようになります。**同じ 1 ファイルを Claude Code と Claude Desktop の両方に
登録できる**のがポイントです。

```
MCP クライアント ─(stdio)→ このプロキシ ─(HTTP 127.0.0.1:23119)→ mcp-zotero-api → Zotero
                                    └─(PyMuPDF, ローカルPDF)
```

- クラウド Web API 不使用・完全ローカル・起動中の Zotero に即反映
- PDF 本文抽出とハイライト座標計算は PyMuPDF でローカル実行
- Rust ブリッジ(方法B)と違い **ビルド不要**(依存はすべて wheel、clang/CMake 不要)

## 前提

- Zotero を起動し、`mcp-zotero-api` プラグイン (v1.3.0+) をインストール済みであること
- Python 3.10+

## セットアップ

```powershell
# 依存インストール（このディレクトリで）
pip install -r requirements.txt

# 稼働確認: Zotero 起動中なら ok が返る
python -c "import os; os.environ.setdefault('ZOTERO_URL','http://127.0.0.1:23119/mcp'); import zotero_mcp_proxy as z; print(z.zotero_ping())"
```

## Claude Desktop に登録

設定ファイル: `%APPDATA%\Claude\claude_desktop_config.json`
(アプリの Settings → Developer → Edit Config からも開けます)

```json
{
  "mcpServers": {
    "zotero-local": {
      "command": "C:\\Users\\maeda\\miniconda3\\python.exe",
      "args": ["C:\\Users\\maeda\\Documents\\py_scripts\\zotero-mcp\\zotero-mcp-py\\zotero_mcp_proxy.py"],
      "env": {
        "ZOTERO_URL": "http://127.0.0.1:23119/mcp"
      }
    }
  }
}
```

- `command` / `args` とも **絶対パス**。JSON なので `\` は `\\` にエスケープする。
- **`command` に `python` ではなく python.exe の絶対パスを使う**こと。Claude Desktop は
  GUI 起動で shell の PATH を継承しないことがあり、かつ依存(mcp/pymupdf/httpx)は
  この Python 環境(`C:\Users\maeda\miniconda3`)に入っているため。
- 保存後 Claude Desktop を**完全に終了して再起動**(タスクトレイからも終了)。

## Claude Code に登録

Claude Desktop と**同じスキーマ**です。CLI で一発登録できます:

```powershell
claude mcp add zotero-local -e ZOTERO_URL=http://127.0.0.1:23119/mcp -- "C:\Users\maeda\miniconda3\python.exe" "C:\Users\maeda\Documents\py_scripts\zotero-mcp\zotero-mcp-py\zotero_mcp_proxy.py"
claude mcp list
# 解除: claude mcp remove zotero-local
```

Claude Code で方法A(Bash+curl)を併用していた場合、二重操作を避けるため
プロキシに一本化するのがおすすめです。

## 公開ツール一覧

| 分類 | ツール | 対応エンドポイント / 処理 |
|------|--------|---------------------------|
| 読み取り | `zotero_ping` | `GET /ping` |
| | `zotero_search` | `POST /search` |
| | `zotero_lookup_citekey` | `POST /citekey` (BetterBibTeX) |
| | `zotero_get_item` | `POST /item` |
| | `zotero_get_children` | `POST /children` |
| | `zotero_list_items` | `POST /items` |
| | `zotero_read_pdf` | PyMuPDF ローカル本文抽出 |
| | `zotero_pdf_outline` | PyMuPDF 目次(TOC) |
| 注釈 | `zotero_create_highlight` | PyMuPDF 座標計算 + `POST /annotations` |
| | `zotero_create_area_annotation` | `POST /annotations` (image) |
| | `zotero_update_annotation` | `POST /annotations/update` |
| | `zotero_delete_annotations` | `POST /annotations/delete` |
| 整理 | `zotero_create_note` | `POST /notes` |
| | `zotero_update_item` | `POST /items/update` |
| | `zotero_set_tags` | `POST /tags` |
| | `zotero_set_collections` | `POST /collections` |
| | `zotero_create_collection` | `POST /collections/create` |
| | `zotero_add_attachment` | `POST /attachments` |
| 削除 | `zotero_delete_items` | `POST /items/delete` |
| | `zotero_delete_collection` | `POST /collections/delete` |

## セマンティックカラー

`zotero_create_highlight` / `zotero_create_area_annotation` の `color` には
名前(`section1`/`section2`/`section3`/`positive`/`detail`/`negative`/`code`/`yellow`)
または生の `#rrggbb` を渡せます。

## 座標について

PyMuPDF の `search_for()` は左上原点(y 下向き)、Zotero の `annotationPosition`
は左下原点(y 上向き)。プロキシは `new_y = page_height - old_y` で反転しており、
Rust クライアントの `search_for_rects()` と同一の変換です。ハイライトは
**ページ内で一意なテキスト**を使ってください(検索は大文字小文字・空白を区別)。

## ハマりどころ

- Zotero が起動していないと 127.0.0.1:23119 に繋がらない
- ハイライト対象テキストが見つからない → ページ内で一意な正確な部分文字列にする
- 旧クラウド MCP と併用すると書込が二重/同期待ちになる → ローカル運用では外す

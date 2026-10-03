"""
Imports conversations from Anthropic's official Claude data export
(claude.ai -> Settings -> Privacy -> Export data) into Foundation.

Unlike chatgpt_provider.py / gemini_provider.py, this never touches a
browser: the export already contains every conversation as structured JSON,
so this just reads conversations.json (from a .zip or an already-extracted
folder) and POSTs each one to the Ingestie Gateway (/api/ingest/chat) —
same endpoint, same server-side dedup, as the browser-driven importers.

Usage (called from bulk_import.py, not run directly):
    import_from_export(export_path, api_url, token, limit=None)
"""

import json
import zipfile
from pathlib import Path
from typing import Optional

from transport import post_import


def _load_conversations(export_path: str):
    """export_path may be a .zip (as downloaded) or an already-extracted
    folder. Either way, conversations.json sits at the top level."""
    p = Path(export_path)
    if p.is_dir():
        conv_file = p / "conversations.json"
        if not conv_file.exists():
            raise FileNotFoundError(f"conversations.json not found in {p}")
        return json.loads(conv_file.read_text(encoding="utf-8"))

    if p.is_file() and p.suffix.lower() == ".zip":
        with zipfile.ZipFile(p) as zf:
            names = [n for n in zf.namelist() if n.endswith("conversations.json")]
            if not names:
                raise FileNotFoundError(f"conversations.json not found inside {p}")
            with zf.open(names[0]) as f:
                return json.loads(f.read().decode("utf-8"))

    raise FileNotFoundError(f"{export_path} is neither a folder nor a .zip file")

def _message_text(msg: dict) -> str:
    # Prefer the structured content blocks (join only "text" blocks — tool
    # calls/results/thinking blocks, if present in richer conversations, are
    # skipped for now rather than guessed at). Falls back to the flattened
    # top-level "text" field, which is what's present for simple messages.
    blocks = msg.get("content") or []
    parts = [
        b.get("text", "")
        for b in blocks
        if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
    ]
    text = "\n\n".join(parts).strip() if parts else (msg.get("text") or "").strip()

    # attachments[] carries the full text for text-shaped files (extracted_content) —
    # e.g. a pasted .txt/.json/.csv. files[] is metadata-only (file_uuid + file_name),
    # used for binary files (PDFs, images) whose raw bytes Anthropic doesn't include
    # in this export — noted by name so it's at least visible something was attached,
    # but the content itself isn't recoverable from the export alone.
    extras = []
    for att in msg.get("attachments") or []:
        name = att.get("file_name", "attachment")
        content = att.get("extracted_content")
        if content:
            extras.append(f"[Attached: {name}]\n{content}")
    for f in msg.get("files") or []:
        name = f.get("file_name", "file")
        extras.append(f"[Attached: {name} — content not included in this export]")

    if extras:
        text = "\n\n".join([text] + extras) if text else "\n\n".join(extras)
    return text.strip()


def _build_turns(chat_messages: list) -> list:
    turns = []
    for msg in chat_messages:
        role = "assistant" if msg.get("sender") == "assistant" else "user"
        text = _message_text(msg)
        if text:
            turns.append({"role": role, "text": text})
    return turns


def _format_turns(turns: list) -> str:
    return "\n\n".join(f"{'A' if t['role'] == 'assistant' else 'H'}: {t['text']}" for t in turns)

def import_from_export(export_path: str, api_url: str, token: str, imported: set,
                        limit: Optional[int] = None) -> int:
    """Returns the number of newly-imported conversations. `imported` is the
    same kind of set bulk_import.py already tracks (by url this time,
    matching the other providers) — callers persist it via transport.py's
    load_state/save_state exactly as before."""
    conversations = _load_conversations(export_path)
    print(f"Found {len(conversations)} conversation(s) in the export.")

    # Most recent first, so --limit means "the N most recent" like the other
    # providers, not an arbitrary slice of whatever order the export happens
    # to list them in.
    conversations.sort(key=lambda c: c.get("updated_at") or "", reverse=True)

    attachments_with_text = 0
    attachments_binary_only = 0
    done = 0
    for i, conv in enumerate(conversations, start=1):
        if limit and done >= limit:
            break

        uuid = conv.get("uuid")
        if not uuid:
            continue
        # Real Claude URL shape — deriveProviderConversationId() on both the
        # frontend and server already recognizes /chat/<uuid>/ for
        # sourceProvider "claude", so dedup/re-import-refresh works with zero
        # schema changes, the same as extension-imported Claude chats.
        url = f"https://claude.ai/chat/{uuid}"
        if url in imported:
            continue

        chat_messages = conv.get("chat_messages") or []
        turns = _build_turns(chat_messages)
        if not turns:
            continue

        for msg in chat_messages:
            for att in msg.get("attachments") or []:
                if att.get("extracted_content"):
                    attachments_with_text += 1
            attachments_binary_only += len(msg.get("files") or [])

        title = conv.get("name") or next(
            (t["text"][:80] for t in turns if t["role"] == "user"), "Untitled Claude conversation"
        )

        payload = {
            "title": title,
            "content": _format_turns(turns),
            "turns": turns,
            "source": "claude-bulk-import",
            "sourceProvider": "claude",
            "url": url,
            "occurredAt": conv.get("updated_at") or conv.get("created_at"),
        }

        print(f"[{i}/{len(conversations)}] {title}")
        status, body = post_import(api_url, token, payload)
        if 200 <= status < 300:  # gateway: 201 nieuw, 200 upsert
            print(f"  -> imported {len(turns)} turns")
            imported.add(url)
            done += 1
        else:
            print(f"  ! import failed ({status}): {body}")

    if attachments_with_text:
        print(f"Note: {attachments_with_text} attached file(s) had their text content imported inline.")
    if attachments_binary_only:
        print(f"Note: {attachments_binary_only} attached file(s) are binary (PDF/image) — "
              f"referenced by name only, content not included in this export format.")

    return done

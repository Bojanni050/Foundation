#!/usr/bin/env python3
"""
Bulk-imports conversation history into Foundation's Ingestie Gateway
(POST /api/ingest/chat) by driving a real, logged-in browser session with
Playwright.

Usage:
    python bulk_import.py --limit 3          # test run first, recommended
    python bulk_import.py                    # import everything

    python bulk_import.py --token <token> --api-url http://127.0.0.1:4577
"""

import argparse
import mimetypes
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

from transport import load_state, save_state, post_import, post_attachment
from chatgpt_provider import ChatGPTProvider
from gemini_provider import GeminiProvider
from claude_export import import_from_export

ROOT = Path(__file__).resolve().parents[2]
STATE_FILE = Path(__file__).resolve().parent / "imported.json"
DEFAULT_TOKEN_FILE = ROOT / "server" / "data" / "token.txt"


def format_turns(turns):
    return "\n\n".join(f"{'A' if t['role'] == 'assistant' else 'H'}: {t['text']}" for t in turns)


def download_and_upload_images(page, images, api_url, token):
    attachments = []
    for i, img in enumerate(images):
        try:
            if img["kind"] == "url":
                resp = page.request.get(img["src"], timeout=30000)
                if not resp.ok:
                    print(f"    ! image download failed ({resp.status}): {img['src'][:100]}")
                    continue
                data = resp.body()
                mime_type = resp.headers.get("content-type", "image/png").split(";")[0].strip()
            else:
                data = img["data"]
                mime_type = img["mime_type"]
            ext = mimetypes.guess_extension(mime_type) or ".png"
            filename = f"image-{i + 1}{ext}"
            meta = post_attachment(api_url, token, data, filename, mime_type)
            if meta:
                attachments.append(meta)
        except Exception as e:
            print(f"    ! image download error: {e}")
    return attachments


def import_conversation(provider, page, url, title_hint, api_url, token):
    page.goto(url, wait_until="domcontentloaded")
    try:
        # Wait a bit so the conversation renders
        page.wait_for_selector(provider.message_wait_selector, timeout=15000)
    except PWTimeout:
        print(f"  ! no messages found, skipping: {url}")
        return False

    turns, last_date_label, images = provider.collect_turns(page)
    if not turns:
        print(f"  ! no turns extracted, skipping: {url}")
        return False

    occurred_at = None
    if last_date_label:
        occurred_at = provider.parse_relative_date_label(last_date_label)

    attachments = []
    if images:
        print(f"  downloading {len(images)} image(s)...")
        attachments = download_and_upload_images(page, images, api_url, token)

    content = format_turns(turns)
    title = title_hint or next((t["text"][:80] for t in turns if t["role"] == "user"), page.title())

    payload = {
        "title": title,
        "content": content,
        "turns": turns,
        "source": f"{provider.name}-bulk-import",
        "sourceProvider": provider.name,
        "url": url,
        "occurredAt": occurred_at,
        "attachments": attachments,
    }
    status, body = post_import(api_url, token, payload)
    if 200 <= status < 300:  # gateway: 201 = nieuw, 200 = upsert van een gegroeide conversatie
        print(f"  -> imported {len(turns)} turns, {len(attachments)} attachment(s) (occurredAt={occurred_at})")
        return True
    print(f"  ! import failed ({status}): {body}")
    return False


def main():
    if sys.stdout.encoding.lower() != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Bulk-import conversation history into Chronicle.")
    parser.add_argument("--api-url", default="http://127.0.0.1:4577")
    parser.add_argument("--token", default=None, help="Chronicle API token (defaults to server/data/token.txt)")
    parser.add_argument("--limit", type=int, default=None, help="Only import the N most recent conversations")
    parser.add_argument("--headless", action="store_true", help="Run without a visible browser window")
    parser.add_argument("--delay", type=float, default=2.0, help="Seconds to wait between conversations")
    parser.add_argument("--provider", choices=["chatgpt", "gemini", "claude"], default="chatgpt", help="Which provider to import from")
    parser.add_argument("--export-path", default=None, help="Path to the Anthropic export .zip or extracted folder (--provider claude only)")
    args = parser.parse_args()

    token = args.token
    if not token:
        if not DEFAULT_TOKEN_FILE.exists():
            print(f"No --token given and {DEFAULT_TOKEN_FILE} doesn't exist. "
                  f"Start the Chronicle server once to generate it, or pass --token.")
            sys.exit(1)
        token = DEFAULT_TOKEN_FILE.read_text(encoding="utf-8").strip()

    state = load_state(STATE_FILE)
    imported = set(state.get("imported_urls", []))

    # Claude's official data export is already structured JSON — no browser,
    # no login-wait, no scrolling. Handled entirely separately from the
    # Playwright-driven providers below.
    if args.provider == "claude":
        if not args.export_path:
            print("--export-path is required for --provider claude (path to the export .zip or extracted folder).")
            sys.exit(1)
        done = import_from_export(args.export_path, args.api_url, token, imported, limit=args.limit)
        state["imported_urls"] = sorted(list(imported))
        save_state(STATE_FILE, state)
        print(f"Done. Imported {done} new conversation(s); already-imported ones were skipped.")
        return

    if args.provider == "gemini":
        provider = GeminiProvider()
    else:
        provider = ChatGPTProvider()
        
    profile_dir = Path(__file__).resolve().parent / provider.profile_dir_name
    profile_dir.mkdir(exist_ok=True)

    with sync_playwright() as p:
        launch_kwargs = dict(
            headless=args.headless,
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            context = p.chromium.launch_persistent_context(
                str(profile_dir), channel="chrome", **launch_kwargs
            )
        except Exception:
            print("Real Chrome not found (channel='chrome') — falling back to Playwright's bundled Chromium.")
            context = p.chromium.launch_persistent_context(str(profile_dir), **launch_kwargs)
        
        context.add_init_script("""
            try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch(e) {}
            try { if (!window.navigator.chrome) { window.navigator.chrome = { runtime: {} }; } } catch(e) {}
            try { Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch(e) {}
            try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch(e) {}
        """)
        
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(provider.start_url, wait_until="domcontentloaded")

        def check_login():
            return provider.is_logged_in(page)

        if not check_login():
            print(f"Waiting for you to log into {provider.name} in the opened browser window...")
            logged_in = False
            for _ in range(600):  # up to 20 minutes
                try:
                    page.wait_for_timeout(2000)
                except Exception:
                    pass
                if check_login():
                    logged_in = True
                    break
            if not logged_in:
                print("Timed out waiting for login.")
                context.close()
                sys.exit(1)
            print("Logged in.")

        print("Collecting conversation list...")
        links = provider.collect_conversation_links(page, limit=args.limit)
        print(f"Found {len(links)} conversation(s).")

        done = 0
        for i, (href, title_hint) in enumerate(links, start=1):
            url = f"{provider.start_url.rstrip('/')}{href}" if href.startswith("/") else href
            if url in imported:
                continue
            print(f"[{i}/{len(links)}] {title_hint or url}")
            try:
                ok = import_conversation(provider, page, url, title_hint, args.api_url, token)
            except Exception as e:
                print(f"  ! unexpected error, skipping this conversation: {e}")
                ok = False
            if ok:
                imported.add(url)
                state["imported_urls"] = sorted(list(imported))
                save_state(STATE_FILE, state)
                done += 1
            time.sleep(args.delay)

        context.close()

    print(f"Done. Imported {done} new conversation(s); already-imported ones were skipped.")

if __name__ == "__main__":
    main()

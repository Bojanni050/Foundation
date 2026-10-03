import base64
import mimetypes
import re
import urllib.parse
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple

from playwright.sync_api import TimeoutError as PWTimeout
from bs4 import BeautifulSoup
from markdownify import markdownify as md

from base_provider import BaseProvider


WEEKDAYS_NL = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"]
WEEKDAYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
MONTHS_NL = ["januari", "februari", "maart", "april", "mei", "juni", "juli",
             "augustus", "september", "oktober", "november", "december"]

class ChatGPTProvider(BaseProvider):
    @property
    def name(self) -> str:
        return "chatgpt"

    @property
    def profile_dir_name(self) -> str:
        return ".chatgpt_profile"

    @property
    def start_url(self) -> str:
        return "https://chatgpt.com/"

    @property
    def message_wait_selector(self) -> str:
        return "[data-message-author-role]"

    def is_logged_in(self, page) -> bool:
        try:
            return page.query_selector('a[href^="/c/"]') is not None
        except Exception:
            return False

    def parse_relative_date_label(self, label: str) -> Optional[str]:
        if not label:
            return None
        now = datetime.now()
        text = label.strip().lower()

        time_match = re.search(r"(\d{1,2}):(\d{2})", text)
        hours, minutes = (int(time_match.group(1)), int(time_match.group(2))) if time_match else (None, None)

        def with_time(d):
            if hours is not None:
                return d.replace(hour=hours, minute=minutes, second=0, microsecond=0)
            return d

        if re.match(r"^(vandaag|today)\b", text):
            return with_time(now).isoformat()
        if re.match(r"^(gisteren|yesterday)\b", text):
            return with_time(now - timedelta(days=1)).isoformat()

        for idx, (nl, en) in enumerate(zip(WEEKDAYS_NL, WEEKDAYS_EN)):
            if text.startswith(nl) or text.startswith(en):
                py_dow = (now.weekday() + 1) % 7
                diff = (py_dow - idx) % 7
                return with_time(now - timedelta(days=diff)).isoformat()

        m = re.search(r"(\d{1,2})\s+([a-zé]+)\.?\s*(\d{4})?", text)
        if m:
            day = int(m.group(1))
            month_idx = next((i for i, mm in enumerate(MONTHS_NL) if mm.startswith(m.group(2))), None)
            if month_idx is not None:
                year = int(m.group(3)) if m.group(3) else now.year
                candidate = datetime(year, month_idx + 1, day)
                if not m.group(3) and candidate > now:
                    candidate = datetime(year - 1, month_idx + 1, day)
                return with_time(candidate).isoformat()

        for fmt in ("%Y-%m-%dT%H:%M:%S", "%B %d, %Y", "%b %d, %Y"):
            try:
                return datetime.strptime(label.strip(), fmt).isoformat()
            except ValueError:
                continue
        return None

    def collect_conversation_links(self, page, limit: Optional[int] = None) -> List[Tuple[str, str]]:
        found = False
        for attempt in range(3):
            try:
                page.wait_for_selector('a[href^="/c/"]', timeout=15000)
                found = True
                break
            except PWTimeout:
                print(f"  [diag] attempt {attempt + 1}/3: sidebar links not found after 15s, "
                      f"url={page.url!r} title={page.title()!r}")
                if attempt < 2:
                    page.reload(wait_until="domcontentloaded")
                    page.wait_for_timeout(1500)
        
        if not found:
            snippet = ""
            try:
                snippet = page.evaluate("() => document.body.innerText.slice(0, 500)")
            except Exception:
                pass
            print(f"  ! Could not find any conversations in the sidebar after 3 attempts.")
            print(f"  ! Page text snippet: {snippet!r}")
            return []

        handle = page.evaluate_handle(
            """() => {
                const anyLink = document.querySelector('a[href^="/c/"]');
                let el = anyLink && anyLink.parentElement;
                while (el) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return document.scrollingElement;
            }"""
        )
        seen = {}
        def collect_current():
            for a in page.query_selector_all('a[href^="/c/"]'):
                href = a.get_attribute("href")
                if href and href not in seen:
                    seen[href] = (a.inner_text() or "").strip()

        collect_current()
        SETTLE_WAIT_MS = 1500
        REQUIRED_STABLE_SETTLES = 4
        stable_settles = 0
        exhausted = False
        for i in range(300):
            if limit and len(seen) >= limit:
                exhausted = True
                break
            before_links = len(seen)
            before_height = page.evaluate("(el) => el.scrollHeight", handle)

            page.evaluate("(el) => { el.scrollTop = el.scrollHeight; }", handle)
            page.wait_for_timeout(SETTLE_WAIT_MS)

            collect_current()
            after_height = page.evaluate("(el) => el.scrollHeight", handle)
            grew = len(seen) > before_links or after_height > before_height + 4
            stable_settles = 0 if grew else stable_settles + 1

            if stable_settles >= REQUIRED_STABLE_SETTLES:
                exhausted = True
                break
                
        if not exhausted and not limit:
            print("  ! warning: reached max scroll attempts, sidebar may be incomplete")
            
        items = list(seen.items())
        return items[:limit] if limit else items

    def get_last_separator_label(self, page) -> Optional[str]:
        try:
            return page.evaluate(
                """() => {
                    const labels = Array.from(document.querySelectorAll('[role="separator"][aria-label]'))
                        .map(el => el.getAttribute('aria-label'))
                        .filter(Boolean);
                    return labels.length ? labels[labels.length - 1] : null;
                }"""
            )
        except Exception:
            return None

    def _extract_and_strip_images(self, html):
        if "<img" not in html:
            return html, []
        soup = BeautifulSoup(html, "html.parser")
        images = []
        for img in soup.find_all("img"):
            src = img.get("src", "")
            if src.startswith("http://") or src.startswith("https://"):
                images.append({"kind": "url", "src": src})
            elif src.startswith("data:"):
                match = re.match(r"data:([^;,]*)(;base64)?,(.*)", src, re.DOTALL)
                if match:
                    mime_type = match.group(1) or "image/png"
                    try:
                        data = (
                            base64.b64decode(match.group(3))
                            if match.group(2)
                            else urllib.parse.unquote_to_bytes(match.group(3))
                        )
                        if len(data) > 2048:
                            images.append({"kind": "data", "mime_type": mime_type, "data": data})
                    except Exception:
                        pass
            img.decompose()
        return str(soup), images

    def collect_turns(self, page) -> Tuple[List[Dict], Optional[str], List[Dict]]:
        handle = page.evaluate_handle(
            """() => {
                const anyMsg = document.querySelector('[data-message-author-role]');
                let el = anyMsg && anyMsg.parentElement;
                while (el) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return document.scrollingElement;
            }"""
        )

        def snapshot():
            return page.evaluate(
                """() => Array.from(document.querySelectorAll('[data-message-author-role]')).map(n => ({
                    role: n.getAttribute('data-message-author-role') === 'assistant' ? 'assistant' : 'user',
                    html: n.innerHTML,
                }))"""
            )

        last_height = -1
        reached_top = False
        for _ in range(60):
            page.evaluate("(el) => { el.scrollTop = 0; }", handle)
            page.wait_for_timeout(350)
            height = page.evaluate("(el) => el.scrollHeight", handle)
            if height == last_height:
                reached_top = True
                break
            last_height = height
            
        if not reached_top:
            print("  ! warning: reached max scroll-up attempts (60), conversation may be truncated at the top")

        merged = []
        last_date_label = self.get_last_separator_label(page)

        def merge_in(items):
            nonlocal last_date_label
            max_overlap = min(len(merged), len(items))
            overlap = 0
            for candidate in range(max_overlap, 0, -1):
                if all(
                    merged[len(merged) - candidate + i]["role"] == items[i]["role"]
                    and merged[len(merged) - candidate + i]["html"] == items[i]["html"]
                    for i in range(candidate)
                ):
                    overlap = candidate
                    break
            merged.extend(items[overlap:])

            label = self.get_last_separator_label(page)
            if label:
                last_date_label = label

        page.evaluate("(el) => { el.scrollTop = 0; }", handle)
        page.wait_for_timeout(200)
        merge_in(snapshot())

        reached_bottom = False
        for _ in range(500):
            at_bottom = page.evaluate(
                "(el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 4", handle
            )
            if at_bottom:
                merge_in(snapshot())
                reached_bottom = True
                break
            page.evaluate(
                "(el) => { el.scrollTop = Math.min(el.scrollTop + el.clientHeight * 0.5, el.scrollHeight); }",
                handle,
            )
            page.wait_for_timeout(280)
            merge_in(snapshot())

        if not reached_bottom:
            print("  ! warning: reached max scroll-down attempts (500), conversation may be incomplete")

        turns = []
        images = []
        for item in merged:
            cleaned_html, item_images = self._extract_and_strip_images(item["html"])
            images.extend(item_images)
            text = md(cleaned_html, heading_style="ATX", bullets="-").strip()
            if text:
                turns.append({"role": item["role"], "text": text})
        return turns, last_date_label, images

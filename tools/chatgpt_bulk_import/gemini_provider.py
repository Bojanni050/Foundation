import re
from datetime import datetime
from typing import List, Dict, Optional, Tuple

from playwright.sync_api import TimeoutError as PWTimeout
from markdownify import markdownify as md
from bs4 import BeautifulSoup

from base_provider import BaseProvider

class GeminiProvider(BaseProvider):
    @property
    def name(self) -> str:
        return "gemini"

    @property
    def profile_dir_name(self) -> str:
        return ".gemini_profile"

    @property
    def start_url(self) -> str:
        return "https://gemini.google.com"

    @property
    def message_wait_selector(self) -> str:
        return 'user-query, model-response'

    def is_logged_in(self, page) -> bool:
        try:
            # Check for chat window or history links to confirm logged in status
            # Do not use simple href checks as the splash page might have them.
            # Look for the user avatar, prompt textarea, or the history container.
            return page.query_selector('rich-textarea, [aria-label*="Google Account"], [role="textbox"]') is not None
        except Exception:
            return False

    def parse_relative_date_label(self, label: str) -> Optional[str]:
        # Gemini date separators are often "Today", "Previous 7 Days", "2023", etc.
        # Returning None for now unless we find exact matchable timestamps like ChatGPT.
        return None

    def collect_conversation_links(self, page, limit: Optional[int] = None) -> List[Tuple[str, str]]:
        found = False
        for attempt in range(3):
            try:
                page.wait_for_selector('a[href^="/app/"]', timeout=15000)
                found = True
                break
            except PWTimeout:
                if attempt < 2:
                    page.reload(wait_until="domcontentloaded")
                    page.wait_for_timeout(1500)
        
        if not found:
            return []

        # Find the scroll container for sidebar
        handle = page.evaluate_handle(
            """() => {
                const anyLink = document.querySelector('a[href^="/app/"]');
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
            for a in page.query_selector_all('a[href^="/app/"]'):
                href = a.get_attribute("href")
                if href and href not in seen:
                    # The text inside the a tag or its children
                    seen[href] = (a.inner_text() or "").strip()

        collect_current()
        
        for i in range(100):
            if limit and len(seen) >= limit:
                break
            before_height = page.evaluate("(el) => el.scrollHeight", handle)
            page.evaluate("(el) => { el.scrollTop = el.scrollHeight; }", handle)
            page.wait_for_timeout(1000)
            collect_current()
            after_height = page.evaluate("(el) => el.scrollHeight", handle)
            if after_height <= before_height + 4:
                break
                
        items = list(seen.items())
        return items[:limit] if limit else items

    def _extract_text(self, html):
        soup = BeautifulSoup(html, "html.parser")
        return md(str(soup), heading_style="ATX", bullets="-").strip()

    def collect_turns(self, page) -> Tuple[List[Dict], Optional[str], List[Dict]]:
        # This is a skeleton. Gemini's DOM is highly obfuscated or uses Web Components.
        # We use a broad heuristic looking for user queries vs model responses.
        handle = page.evaluate_handle(
            """() => {
                const anyMsg = document.querySelector('user-query, model-response');
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
                """() => {
                    const allNodes = Array.from(document.querySelectorAll('user-query, model-response'));
                    // Filter out any nodes that are inside other matched nodes (just to be absolutely safe against nesting)
                    const nodes = allNodes.filter(n => !allNodes.some(p => p !== n && p.contains(n)));
                    
                    return nodes.map(n => {
                        const tag = n.tagName.toLowerCase();
                        const isUser = tag.includes('user');
                        return {
                            role: isUser ? 'user' : 'assistant',
                            html: n.innerHTML,
                        };
                    });
                }"""
            )

        page.evaluate("(el) => { el.scrollTop = 0; }", handle)
        page.wait_for_timeout(500)
        
        merged = []
        
        def merge_in(items):
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

        merge_in(snapshot())

        for _ in range(50):
            at_bottom = page.evaluate(
                "(el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 4", handle
            )
            if at_bottom:
                merge_in(snapshot())
                break
            page.evaluate(
                "(el) => { el.scrollTop = Math.min(el.scrollTop + el.clientHeight * 0.5, el.scrollHeight); }",
                handle,
            )
            page.wait_for_timeout(500)
            merge_in(snapshot())

        turns = []
        for item in merged:
            text = self._extract_text(item["html"])
            if text:
                turns.append({"role": item["role"], "text": text})
                
        return turns, None, []

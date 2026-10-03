from playwright.sync_api import sync_playwright
from pathlib import Path

profile_dir = Path(__file__).resolve().parent / ".gemini_profile"

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        str(profile_dir), headless=True, args=["--disable-blink-features=AutomationControlled"]
    )
    page = context.pages[0] if context.pages else context.new_page()
    page.goto("https://gemini.google.com/app", wait_until="domcontentloaded")
    try:
        page.wait_for_selector('a[href^="/app/"]', timeout=15000)
        # click first conversation
        first_link = page.query_selector('a[href^="/app/"]')
        if first_link:
            first_link.click()
            page.wait_for_timeout(5000)
            
            # dump dom elements that might be messages
            html = page.evaluate("""() => {
                let out = "";
                // Try finding common elements
                const els = document.querySelectorAll('user-query, model-response, [class*="message"], [class*="query"], [class*="response"]');
                for (let el of els) {
                    if (el.innerText && el.innerText.length > 0) {
                        out += `TAG: ${el.tagName}, CLASS: ${el.className}, TEXT_LEN: ${el.innerText.length}\\n`;
                    }
                }
                return out;
            }""")
            print(html)
    except Exception as e:
        print("Error:", e)
    context.close()

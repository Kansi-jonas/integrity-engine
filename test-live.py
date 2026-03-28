"""Live test of RTKdata Integrity Engine on Render"""
from playwright.sync_api import sync_playwright
import json

BASE = "https://integrity-engine.onrender.com"
AUTH = "rtkdata:Kansi0208!"

def test_all():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            http_credentials={"username": "rtkdata", "password": "Kansi0208!"}
        )
        page = context.new_page()

        results = {}

        # 1. Dashboard
        print("1. Testing Dashboard...")
        page.goto(f"{BASE}/dashboard", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=30000)
        page.screenshot(path="/tmp/ie_dashboard.png", full_page=True)
        title = page.title()
        results["dashboard"] = {"loaded": True, "title": title}
        print(f"   Dashboard loaded: {title}")

        # 2. Coverage Quality
        print("2. Testing Coverage Quality...")
        page.goto(f"{BASE}/dashboard/quality", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=30000)
        page.wait_for_timeout(3000)  # Wait for map
        page.screenshot(path="/tmp/ie_quality.png", full_page=True)
        results["quality"] = {"loaded": True}
        print("   Coverage Quality loaded")

        # 3. System Status
        print("3. Testing System Status...")
        page.goto(f"{BASE}/dashboard/system", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        page.screenshot(path="/tmp/ie_system.png", full_page=True)
        results["system"] = {"loaded": True}
        print("   System Status loaded")

        # 4. Trust
        print("4. Testing Trust...")
        page.goto(f"{BASE}/dashboard/trust", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        page.screenshot(path="/tmp/ie_trust.png", full_page=True)
        results["trust"] = {"loaded": True}
        print("   Trust loaded")

        # 5. Interference
        print("5. Testing Interference...")
        page.goto(f"{BASE}/dashboard/interference", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=30000)
        page.screenshot(path="/tmp/ie_interference.png", full_page=True)
        results["interference"] = {"loaded": True}
        print("   Interference loaded")

        # 6. Forecast
        print("6. Testing Forecast...")
        page.goto(f"{BASE}/dashboard/forecast", timeout=30000)
        page.wait_for_load_state("networkidle", timeout=30000)
        page.wait_for_timeout(2000)
        page.screenshot(path="/tmp/ie_forecast.png", full_page=True)
        results["forecast"] = {"loaded": True}
        print("   Forecast loaded")

        # 7. API checks
        print("7. Testing APIs...")
        apis = [
            "/api/health",
            "/api/health-score",
            "/api/monitor?section=db",
            "/api/quality",
            "/api/coverage",
            "/api/report",
            "/api/sla",
            "/api/analytics",
            "/api/probe?action=status",
        ]
        for api in apis:
            try:
                resp = page.goto(f"{BASE}{api}", timeout=15000)
                status = resp.status if resp else 0
                results[f"api:{api}"] = {"status": status}
                print(f"   {api}: {status}")
            except Exception as e:
                results[f"api:{api}"] = {"error": str(e)}
                print(f"   {api}: ERROR {e}")

        browser.close()

        print("\n=== RESULTS ===")
        passed = sum(1 for v in results.values() if v.get("loaded") or v.get("status") == 200)
        total = len(results)
        print(f"Passed: {passed}/{total}")
        print(f"Screenshots saved to /tmp/ie_*.png")

        return results

if __name__ == "__main__":
    test_all()

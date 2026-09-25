"""Check Apple/Turkey/provider 405 stock and notify Discord once per restock."""
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

STATE = Path(__file__).with_name("state.json")
API = "https://api.grizzlysms.com/stubs/handler_api.php"


def count_provider(payload):
    node = payload["62"]["wx"]["providers"].get("405", {"count": 0})
    count = node["count"]
    if isinstance(count, bool) or not str(count).isdigit():
        raise ValueError("provider count is invalid")
    return int(count)


def main():
    key = os.environ["GRIZZLY_API_KEY"]
    webhook = os.environ["DISCORD_WEBHOOK_URL"]
    parsed = urllib.parse.urlparse(webhook)
    if parsed.scheme != "https" or parsed.netloc != "discord.com" or not parsed.path.startswith("/api/webhooks/"):
        raise ValueError("Invalid Discord webhook URL")
    query = urllib.parse.urlencode({"api_key": key, "action": "getPricesV3", "service": "wx", "country": "62"})
    with urllib.request.urlopen(urllib.request.Request(API + "?" + query, headers={"User-Agent": "GrizzlyStockCheck/1.0"}), timeout=20) as response:
        body = response.read(1_000_000)
    data = json.loads(body)
    count = count_provider(data)
    previous = json.loads(STATE.read_text(encoding="utf-8"))
    print(f"Provider 405 stock: {count}")
    available = count > 0
    if available and not previous["available"]:
        message = {"content": f"🔔 GrizzlySMS Apple / Turkey / provider 405 재고: **{count}개**\nhttps://grizzlysms.com/",
                   "allowed_mentions": {"parse": []}}
        request = urllib.request.Request(webhook, data=json.dumps(message).encode(),
                                         headers={"Content-Type": "application/json", "User-Agent": "GrizzlyStockCheck/1.0"}, method="POST")
        with urllib.request.urlopen(request, timeout=20) as response:
            response.read()
        print("Discord alert sent")
    if available != previous["available"]:
        STATE.write_text(json.dumps({"available": available}) + "\n", encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Never print request URLs or response bodies; they can contain secrets.
        print(f"Stock check failed: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)

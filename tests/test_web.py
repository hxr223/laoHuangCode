import json
import unittest
from urllib.request import urlopen

from laohuangcode.web import EventLog, WebDashboard


class EventLogTests(unittest.TestCase):
    def test_reader_can_fetch_only_events_after_a_known_id(self):
        log = EventLog()

        first = log.record("user_message", {"content": "hello"})
        second = log.record("model_response", {"round": 1, "tool_call_count": 2})

        self.assertEqual(first["id"], 1)
        self.assertEqual(second["id"], 2)
        self.assertEqual(log.read(after_id=1), [second])


class WebDashboardTests(unittest.TestCase):
    def test_browser_can_load_dashboard_and_event_api(self):
        log = EventLog()
        log.record("model_response", {"round": 1, "tool_call_count": 4})
        dashboard = WebDashboard(log, port=0)
        dashboard.start()

        try:
            with urlopen(dashboard.url, timeout=2) as response:
                page = response.read().decode("utf-8")
            with urlopen(f"{dashboard.url}api/events?after=0", timeout=2) as response:
                events = json.loads(response.read().decode("utf-8"))
        finally:
            dashboard.stop()

        self.assertIn("laoHuangCode", page)
        self.assertEqual(events["events"][0]["payload"]["tool_call_count"], 4)


if __name__ == "__main__":
    unittest.main()

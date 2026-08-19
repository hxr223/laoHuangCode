import unittest

from laohuangcode.ui_state import UIEventReducer


class UIEventReducerTests(unittest.TestCase):
    def test_model_deltas_are_provisional_until_committed(self):
        reducer = UIEventReducer()

        reducer.apply(
            {
                "kind": "model.request_started",
                "correlation_id": "request-1",
                "payload": {},
            }
        )
        update = reducer.apply(
            {
                "kind": "model.text_delta",
                "correlation_id": "request-1",
                "payload": {"text": "hello"},
            }
        )

        self.assertEqual(update.text, "hello")
        self.assertEqual(reducer.state.active_response.text, "hello")
        self.assertEqual(reducer.state.active_response.status, "provisional")

        reducer.apply(
            {
                "kind": "model.response_committed",
                "correlation_id": "request-1",
                "payload": {},
            }
        )
        self.assertEqual(reducer.state.active_response.status, "committed")

    def test_parallel_tool_output_is_grouped_by_correlation_id(self):
        reducer = UIEventReducer()
        for tool_id in ("call-1", "call-2"):
            reducer.apply(
                {
                    "kind": "tool.started",
                    "correlation_id": tool_id,
                    "payload": {"name": "bash", "arguments": {}},
                }
            )

        reducer.apply(
            {
                "kind": "tool.output_delta",
                "correlation_id": "call-2",
                "payload": {"stream": "stderr", "text": "warning"},
            }
        )

        self.assertEqual(reducer.state.active_tools["call-1"].stderr, "")
        self.assertEqual(
            reducer.state.active_tools["call-2"].stderr, "warning"
        )


if __name__ == "__main__":
    unittest.main()

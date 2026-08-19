import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest

from laohuangcode.agent import AgentError, CodingAgent
from laohuangcode.permissions import PermissionGate
from laohuangcode.tools import ToolRegistry


class FakeMessage:
    def __init__(self, *, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls

    def model_dump(self, *, exclude_none=False):
        message = {"role": "assistant", "content": self.content}
        if self.tool_calls is not None:
            message["tool_calls"] = [call.model_dump() for call in self.tool_calls]
        if exclude_none:
            message = {key: value for key, value in message.items() if value is not None}
        return message


class FakeToolCall:
    def __init__(self, call_id, name, arguments):
        self.id = call_id
        self.type = "function"
        self.function = SimpleNamespace(name=name, arguments=arguments)

    def model_dump(self):
        return {
            "id": self.id,
            "type": self.type,
            "function": {
                "name": self.function.name,
                "arguments": self.function.arguments,
            },
        }


class FakeCompletions:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.requests = []

    def create(self, **request):
        self.requests.append(request)
        message = next(self.messages)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class FailingCompletions:
    def create(self, **request):
        raise RuntimeError("network unavailable")


def fake_client(*messages):
    completions = FakeCompletions(messages)
    return SimpleNamespace(
        chat=SimpleNamespace(completions=completions), completions=completions
    )


class CodingAgentTests(unittest.TestCase):
    def test_user_receives_a_direct_model_response(self):
        with tempfile.TemporaryDirectory() as directory:
            client = fake_client(FakeMessage(content="Hello from the model"))
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
            )

            result = agent.run("Say hello")

            self.assertEqual(result, "Hello from the model")

    def test_agent_executes_a_tool_and_returns_the_follow_up_response(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "answer.txt").write_text("42", encoding="utf-8")
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall("call_1", "read", '{"path":"answer.txt"}')
                    ]
                ),
                FakeMessage(content="The answer is 42."),
            )
            events = []
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(root),
                on_tool_event=lambda name, arguments, result: events.append(
                    (name, arguments, result)
                ),
            )

            result = agent.run("Read the answer")

            self.assertEqual(result, "The answer is 42.")
            tool_message = client.completions.requests[1]["messages"][-1]
            self.assertEqual(tool_message["role"], "tool")
            self.assertEqual(tool_message["tool_call_id"], "call_1")
            self.assertIn('"content": "42"', tool_message["content"])
            self.assertEqual(events[0][0], "read")
            self.assertEqual(events[0][1], {"path": "answer.txt"})
            self.assertTrue(events[0][2]["ok"])

    def test_agent_stops_at_the_tool_round_limit_without_unmatched_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            call = lambda call_id: FakeMessage(
                tool_calls=[FakeToolCall(call_id, "read", '{"path":"missing"}')]
            )
            client = fake_client(call("call_1"), call("call_2"))
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
                max_tool_rounds=1,
            )

            with self.assertRaisesRegex(AgentError, "limit of 1"):
                agent.run("Keep reading")

            self.assertEqual(agent.messages[-1]["role"], "tool")

    def test_multiple_tool_calls_run_in_returned_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            "call_1",
                            "write",
                            '{"path":"result.txt","content":"done"}',
                        ),
                        FakeToolCall(
                            "call_2", "read", '{"path":"result.txt"}'
                        ),
                    ]
                ),
                FakeMessage(content="Finished."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(root),
            )

            result = agent.run("Create and read a result")

            self.assertEqual(result, "Finished.")
            self.assertEqual(
                (root / "result.txt").read_text(encoding="utf-8"), "done"
            )
            tool_messages = client.completions.requests[1]["messages"][-2:]
            self.assertEqual(
                [message["tool_call_id"] for message in tool_messages],
                ["call_1", "call_2"],
            )

    def test_consecutive_user_turns_share_conversation_history(self):
        with tempfile.TemporaryDirectory() as directory:
            client = fake_client(
                FakeMessage(content="First answer"),
                FakeMessage(content="Second answer"),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
            )

            agent.run("First question")
            agent.run("Second question")

            second_request = client.completions.requests[1]["messages"]
            self.assertEqual(
                [message["role"] for message in second_request],
                ["system", "user", "assistant", "user"],
            )
            self.assertEqual(second_request[-2]["content"], "First answer")

    def test_api_failures_become_actionable_agent_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            completions = FailingCompletions()
            client = SimpleNamespace(
                chat=SimpleNamespace(completions=completions)
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
            )

            with self.assertRaisesRegex(
                AgentError, "Model request failed: network unavailable"
            ):
                agent.run("Hello")

    def test_events_group_batch_tool_calls_under_one_model_round(self):
        with tempfile.TemporaryDirectory() as directory:
            events = []
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            "call_1",
                            "write",
                            '{"path":"trace.txt","content":"hello"}',
                        ),
                        FakeToolCall(
                            "call_2", "read", '{"path":"trace.txt"}'
                        ),
                    ]
                ),
                FakeMessage(content="Done"),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
                on_agent_event=lambda event_type, payload: events.append(
                    (event_type, payload)
                ),
            )

            agent.run("Trace this")

            model_responses = [
                payload for event_type, payload in events
                if event_type == "model_response"
            ]
            tool_starts = [
                payload for event_type, payload in events
                if event_type == "tool_start"
            ]
            self.assertEqual(model_responses[0]["round"], 1)
            self.assertEqual(model_responses[0]["tool_call_count"], 2)
            self.assertEqual(model_responses[0]["tool_names"], ["write", "read"])
            self.assertEqual(
                [(event["round"], event["index"]) for event in tool_starts],
                [(1, 1), (1, 2)],
            )
            self.assertEqual(
                tool_starts[0]["arguments"]["content"], "<5 chars>"
            )
            self.assertEqual(model_responses[1]["round"], 2)
            self.assertEqual(model_responses[1]["tool_call_count"], 0)

    def test_events_distinguish_consecutive_user_turns(self):
        with tempfile.TemporaryDirectory() as directory:
            events = []
            agent = CodingAgent(
                client=fake_client(
                    FakeMessage(content="First"),
                    FakeMessage(content="Second"),
                ),
                model="test-model",
                tools=ToolRegistry(Path(directory)),
                on_agent_event=lambda event_type, payload: events.append(
                    (event_type, payload)
                ),
            )

            agent.run("Question one")
            agent.run("Question two")

            model_requests = [
                payload
                for event_type, payload in events
                if event_type == "model_request"
            ]
            self.assertEqual(
                [(event["turn"], event["round"]) for event in model_requests],
                [(1, 1), (2, 1)],
            )

    def test_denied_tool_is_reported_to_model_without_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = []
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            "call_1",
                            "write",
                            '{"path":"blocked.txt","content":"nope"}',
                        )
                    ]
                ),
                FakeMessage(content="The write was denied."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(root),
                permission_gate=PermissionGate(
                    prompt=lambda name, arguments: "n"
                ),
                on_agent_event=lambda event_type, payload: events.append(
                    (event_type, payload)
                ),
            )

            result = agent.run("Write a file")

            self.assertEqual(result, "The write was denied.")
            self.assertFalse((root / "blocked.txt").exists())
            tool_message = client.completions.requests[1]["messages"][-1]
            self.assertIn("denied", tool_message["content"])
            self.assertTrue(
                any(event_type == "tool_denied" for event_type, _ in events)
            )


if __name__ == "__main__":
    unittest.main()

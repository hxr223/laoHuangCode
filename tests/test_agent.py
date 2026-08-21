import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest

from laohuangcode.agent import AgentError, CodingAgent
from laohuangcode.cancellation import CancelToken
from laohuangcode.events import EventBus, EventKind
from laohuangcode.tools import ToolRegistry


class FakeMessage:
    def __init__(self, *, content=None, tool_calls=None, usage=None):
        self.content = content
        self.tool_calls = tool_calls
        self.usage = usage

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
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message)], usage=message.usage
        )


class FailingCompletions:
    def create(self, **request):
        raise RuntimeError("network unavailable")


class AuthenticationFailure(Exception):
    status_code = 401


class AuthenticationFailingCompletions:
    def create(self, **request):
        raise AuthenticationFailure("invalid API key")


def fake_client(*messages):
    completions = FakeCompletions(messages)
    return SimpleNamespace(
        chat=SimpleNamespace(completions=completions), completions=completions
    )


class CodingAgentTests(unittest.TestCase):
    def test_model_can_switch_without_losing_conversation_history(self):
        original_client = fake_client(FakeMessage(content="hello"))
        replacement_client = fake_client(FakeMessage(content="switched"))
        events = []
        with tempfile.TemporaryDirectory() as directory:
            agent = CodingAgent(
                client=original_client,
                model="old-model",
                tools=ToolRegistry(Path(directory)),
                on_agent_event=lambda event_type, payload: events.append(
                    (event_type, payload)
                ),
            )
            agent.run("first turn")

            agent.switch_model(
                client=replacement_client,
                model="new-model",
                provider="openai",
            )
            answer = agent.run("second turn")

        self.assertEqual(answer, "switched")
        self.assertEqual(
            replacement_client.completions.requests[0]["model"], "new-model"
        )
        self.assertTrue(
            any(message.get("content") == "first turn" for message in agent.messages)
        )
        self.assertTrue(any(event[0] == "model_switched" for event in events))

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

    def test_agent_does_not_limit_tool_rounds_or_model_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            calls = [
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            f"call_{index}",
                            "read",
                            json.dumps({"path": f"missing-{index}"}),
                        )
                    ]
                )
                for index in range(21)
            ]
            client = fake_client(
                *calls,
                FakeMessage(content="Finished after 21 tool rounds."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
            )

            result = agent.run("Read every missing path")

            self.assertEqual(result, "Finished after 21 tool rounds.")
            self.assertEqual(len(client.completions.requests), 22)
            self.assertTrue(
                all(
                    request["tool_choice"] == "auto"
                    for request in client.completions.requests
                )
            )

    def test_repeated_tool_call_forces_a_final_answer_after_three_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            call = lambda call_id: FakeMessage(
                tool_calls=[FakeToolCall(call_id, "read", '{"path":"missing"}')]
            )
            events = []
            event_bus = EventBus()
            context = SimpleNamespace(
                event_bus=event_bus,
                session_id="session-1",
                task_id="task-1",
                cancel_token=CancelToken(),
            )
            client = fake_client(
                call("call_1"),
                call("call_2"),
                call("call_3"),
                FakeMessage(content="No more tool calls."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
                on_agent_event=lambda event_type, payload: events.append(
                    (event_type, payload)
                ),
            )

            result = agent.run("Repeat forever", context)

            self.assertEqual(result, "No more tool calls.")
            self.assertEqual(len(client.completions.requests), 4)
            self.assertEqual(client.completions.requests[-1]["tool_choice"], "none")
            guard = next(
                payload
                for event_type, payload in events
                if event_type == "agent_guard_triggered"
            )
            self.assertIn("repeated tool call", guard["reason"])
            self.assertEqual(guard["tool_rounds"], 3)
            canonical = event_bus.drain()
            self.assertTrue(
                any(
                    event.kind is EventKind.AGENT_GUARD_TRIGGERED
                    and "repeated tool call" in event.payload["reason"]
                    for event in canonical
                )
            )
            summaries = [
                event
                for event in canonical
                if event.kind is EventKind.MODEL_RESPONSE_SUMMARY
            ]
            self.assertEqual(len(summaries), 4)
            self.assertEqual(summaries[0].payload["tool_names"], ("read",))
            self.assertGreater(summaries[0].payload["total_tokens"], 0)

    def test_repeated_tool_counter_resets_after_a_different_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "one.txt").write_text("one", encoding="utf-8")
            (root / "two.txt").write_text("two", encoding="utf-8")
            call = lambda call_id, path: FakeMessage(
                tool_calls=[
                    FakeToolCall(call_id, "read", json.dumps({"path": path}))
                ]
            )
            client = fake_client(
                call("call_1", "one.txt"),
                call("call_2", "two.txt"),
                call("call_3", "one.txt"),
                call("call_4", "one.txt"),
                FakeMessage(content="Finished normally."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(root),
            )

            self.assertEqual(agent.run("Read files"), "Finished normally.")
            self.assertTrue(
                all(
                    request["tool_choice"] == "auto"
                    for request in client.completions.requests
                )
            )

    def test_token_budget_forces_final_without_committing_unmatched_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            first = FakeMessage(
                tool_calls=[
                    FakeToolCall("call_1", "read", '{"path":"missing"}')
                ],
                usage={"total_tokens": 101},
            )
            client = fake_client(first, FakeMessage(content="Budget reached."))
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
                max_total_tokens=100,
            )

            result = agent.run("Spend tokens")

            self.assertEqual(result, "Budget reached.")
            self.assertEqual(client.completions.requests[-1]["tool_choice"], "none")
            self.assertFalse(
                any(message.get("tool_calls") for message in agent.messages)
            )

    def test_elapsed_budget_can_force_no_tool_answer_immediately(self):
        with tempfile.TemporaryDirectory() as directory:
            client = fake_client(FakeMessage(content="Time limit."))
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
                max_elapsed_seconds=1e-12,
            )

            self.assertEqual(agent.run("No time"), "Time limit.")
            self.assertEqual(client.completions.requests[0]["tool_choice"], "none")

    def test_failed_forced_final_reports_guard_counters_and_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            call = lambda call_id: FakeMessage(
                tool_calls=[FakeToolCall(call_id, "read", '{"path":"missing"}')]
            )
            client = fake_client(
                call("call_1"),
                call("call_2"),
                call("call_3"),
                call("call_4"),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
            )

            with self.assertRaisesRegex(
                AgentError,
                "repeated tool call detected.*Tool rounds: 3; model requests: 4",
            ):
                agent.run("Ignore the guard")

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

    def test_tool_batch_executes_concurrently_and_returns_source_order(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wait_for_second = (
                "touch first.started; "
                "for _ in {1..100}; do "
                "[ -f second.started ] && { printf first; exit 0; }; "
                "sleep 0.01; done; exit 1"
            )
            wait_for_first = (
                "touch second.started; "
                "for _ in {1..100}; do "
                "[ -f first.started ] && { printf second; exit 0; }; "
                "sleep 0.01; done; exit 1"
            )
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            "call_1",
                            "bash",
                            json.dumps({"command": wait_for_second}),
                        ),
                        FakeToolCall(
                            "call_2",
                            "bash",
                            json.dumps({"command": wait_for_first}),
                        ),
                    ]
                ),
                FakeMessage(content="Finished."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(root, bash_timeout=2),
            )

            agent.run("Run both checks")

            tool_messages = client.completions.requests[1]["messages"][-2:]
            results = [json.loads(message["content"]) for message in tool_messages]
            self.assertEqual(
                [message["tool_call_id"] for message in tool_messages],
                ["call_1", "call_2"],
            )
            self.assertEqual(
                [(result["ok"], result["stdout"]) for result in results],
                [(True, "first"), (True, "second")],
            )

    def test_global_sequential_mode_runs_tool_calls_one_by_one(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wait_for_second = (
                "touch first.started; "
                "for _ in {1..10}; do "
                "[ -f second.started ] && exit 0; sleep 0.01; "
                "done; exit 1"
            )
            wait_for_first = (
                "touch second.started; "
                "[ -f first.started ]"
            )
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            "call_1",
                            "bash",
                            json.dumps({"command": wait_for_second}),
                        ),
                        FakeToolCall(
                            "call_2",
                            "bash",
                            json.dumps({"command": wait_for_first}),
                        ),
                    ]
                ),
                FakeMessage(content="Finished."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(root, bash_timeout=1),
                tool_execution="sequential",
            )

            agent.run("Run sequentially")

            tool_messages = client.completions.requests[1]["messages"][-2:]
            results = [json.loads(message["content"]) for message in tool_messages]
            self.assertEqual([result["ok"] for result in results], [False, True])

    def test_one_sequential_tool_forces_the_whole_batch_to_run_sequentially(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            "call_1",
                            "bash",
                            json.dumps(
                                {"command": "sleep 0.1; touch first.done"}
                            ),
                        ),
                        FakeToolCall(
                            "call_2",
                            "bash",
                            json.dumps({"command": "[ -f first.done ]"}),
                        ),
                    ]
                ),
                FakeMessage(content="Finished."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(
                    root, execution_modes={"bash": "sequential"}
                ),
            )

            agent.run("Run with a sequential tool")

            tool_messages = client.completions.requests[1]["messages"][-2:]
            results = [json.loads(message["content"]) for message in tool_messages]
            self.assertEqual([result["ok"] for result in results], [True, True])

    def test_completion_events_are_live_while_messages_stay_source_ordered(self):
        with tempfile.TemporaryDirectory() as directory:
            events = []
            client = fake_client(
                FakeMessage(
                    tool_calls=[
                        FakeToolCall(
                            "call_1",
                            "bash",
                            '{"command":"sleep 0.1; printf slow"}',
                        ),
                        FakeToolCall(
                            "call_2", "bash", '{"command":"printf fast"}'
                        ),
                    ]
                ),
                FakeMessage(content="Finished."),
            )
            agent = CodingAgent(
                client=client,
                model="test-model",
                tools=ToolRegistry(Path(directory)),
                on_agent_event=lambda event_type, payload: events.append(
                    (event_type, payload)
                ),
            )

            agent.run("Run a slow and a fast tool")

            completed_ids = [
                payload["tool_call_id"]
                for event_type, payload in events
                if event_type == "tool_result"
            ]
            tool_messages = client.completions.requests[1]["messages"][-2:]
            self.assertEqual(completed_ids, ["call_2", "call_1"])
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

    def test_authentication_failures_point_to_provider_login(self):
        with tempfile.TemporaryDirectory() as directory:
            client = SimpleNamespace(
                chat=SimpleNamespace(
                    completions=AuthenticationFailingCompletions()
                )
            )
            agent = CodingAgent(
                client=client,
                model="deepseek-v4-flash",
                provider="deepseek",
                tools=ToolRegistry(Path(directory)),
            )

            with self.assertRaisesRegex(AgentError, r"/login deepseek"):
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

if __name__ == "__main__":
    unittest.main()

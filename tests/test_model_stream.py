import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest

from laohuangcode.agent import AgentCancelled, AgentError, CodingAgent
from laohuangcode.cancellation import CancelToken
from laohuangcode.events import EventBus, EventKind
from laohuangcode.model_stream import (
    ChatCompletionStreamer,
    ModelStreamCancelled,
    ModelStreamError,
    StaleModelRequest,
)
from laohuangcode.tools import ToolRegistry


def chunk(*, delta=None, finish_reason=None, usage=None):
    choices = []
    if delta is not None or finish_reason is not None:
        choices.append(
            SimpleNamespace(delta=delta, finish_reason=finish_reason)
        )
    return SimpleNamespace(choices=choices, usage=usage)


def delta(*, content=None, reasoning_content=None, tool_calls=None):
    return SimpleNamespace(
        content=content,
        reasoning_content=reasoning_content,
        tool_calls=tool_calls,
    )


def tool_fragment(
    index, *, call_id=None, name=None, arguments=None, call_type=None
):
    return SimpleNamespace(
        index=index,
        id=call_id,
        type=call_type,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


class FakeStream:
    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False

    def __iter__(self):
        yield from self.chunks

    def close(self):
        self.closed = True


class RaisingStream:
    def __init__(self, *, first_chunk=None, error=None):
        self.first_chunk = first_chunk
        self.error = error or RuntimeError("stream disconnected")
        self.closed = False

    def __iter__(self):
        if self.first_chunk is not None:
            yield self.first_chunk
        raise self.error

    def close(self):
        self.closed = True


class FakeCompletions:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.requests = []

    def create(self, **request):
        self.requests.append(request)
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class CancellingTools:
    definitions = [{"type": "function", "function": {"name": "read"}}]

    @staticmethod
    def execution_mode(_name):
        return None

    @staticmethod
    def execute(_name, _arguments, context=None):
        context.cancel_token.cancel("cancel during tool")
        return {"ok": False, "status": "cancelled", "error": "cancel during tool"}


class ModelStreamTests(unittest.TestCase):
    def test_assembles_reasoning_content_tool_calls_and_usage(self):
        events = []
        stream = FakeStream(
            [
                chunk(delta=delta(reasoning_content="think ")),
                chunk(
                    delta=delta(
                        tool_calls=[
                            tool_fragment(
                                0,
                                call_id="call_",
                                name="re",
                                arguments='{"pa',
                                call_type="function",
                            )
                        ]
                    )
                ),
                chunk(
                    delta=delta(
                        tool_calls=[
                            tool_fragment(
                                0,
                                call_id="1",
                                name="ad",
                                arguments='th":"README.md"}',
                            )
                        ]
                    )
                ),
                chunk(delta=delta(), finish_reason="tool_calls"),
                chunk(usage={"prompt_tokens": 7, "completion_tokens": 3}),
            ]
        )
        completions = FakeCompletions(stream)

        result = ChatCompletionStreamer(completions).complete(
            model="deepseek-reasoner",
            messages=[],
            tools=[],
            on_delta=lambda kind, payload: events.append((kind, payload)),
        )

        self.assertEqual(result.reasoning_content, "think ")
        self.assertEqual(result.tool_calls[0].id, "call_1")
        self.assertEqual(result.tool_calls[0].function.name, "read")
        self.assertEqual(
            result.tool_calls[0].function.arguments,
            '{"path":"README.md"}',
        )
        self.assertEqual(result.usage["completion_tokens"], 3)
        self.assertTrue(completions.requests[0]["stream"])
        self.assertEqual(
            completions.requests[0]["stream_options"],
            {"include_usage": True},
        )
        self.assertTrue(any(kind == "model_reasoning_delta" for kind, _ in events))
        self.assertTrue(any(kind == "model_tool_call_delta" for kind, _ in events))

    def test_retries_once_when_stream_fails_before_first_delta(self):
        first = RaisingStream()
        second = FakeStream(
            [
                chunk(delta=delta(content="done")),
                chunk(delta=delta(), finish_reason="stop"),
            ]
        )
        completions = FakeCompletions(first, second)

        result = ChatCompletionStreamer(completions).complete(
            model="model", messages=[], tools=[]
        )

        self.assertEqual(result.content, "done")
        self.assertEqual(len(completions.requests), 2)
        self.assertTrue(first.closed)

    def test_does_not_silently_retry_after_a_delta(self):
        first = RaisingStream(first_chunk=chunk(delta=delta(content="partial")))
        completions = FakeCompletions(first)

        with self.assertRaisesRegex(ModelStreamError, "disconnected"):
            ChatCompletionStreamer(completions).complete(
                model="model", messages=[], tools=[]
            )

        self.assertEqual(len(completions.requests), 1)
        self.assertTrue(first.closed)

    def test_rejects_truncated_response(self):
        completions = FakeCompletions(
            FakeStream(
                [
                    chunk(delta=delta(content="partial")),
                    chunk(delta=delta(), finish_reason="length"),
                ]
            )
        )

        with self.assertRaisesRegex(ModelStreamError, "finish_reason=length"):
            ChatCompletionStreamer(completions).complete(
                model="model", messages=[], tools=[]
            )

    def test_cancel_and_stale_request_abort_stream(self):
        token = CancelToken()

        def cancelling_chunks():
            yield chunk(delta=delta(content="partial"))
            token.cancel("stop now")
            yield chunk(delta=delta(content="ignored"))

        stream = FakeStream(cancelling_chunks())
        with self.assertRaisesRegex(ModelStreamCancelled, "stop now"):
            ChatCompletionStreamer(FakeCompletions(stream)).complete(
                model="model", messages=[], tools=[], cancel_token=token
            )
        self.assertTrue(stream.closed)

        active_checks = iter([True, False])
        with self.assertRaises(StaleModelRequest):
            ChatCompletionStreamer(
                FakeCompletions(
                    FakeStream([chunk(delta=delta(content="stale"))])
                )
            ).complete(
                model="model",
                messages=[],
                tools=[],
                request_id="old-request",
                is_request_active=lambda _request_id: next(active_checks),
            )

    def test_agent_preserves_reasoning_for_tool_round_then_strips_on_switch(self):
        first = FakeStream(
            [
                chunk(delta=delta(reasoning_content="private reasoning")),
                chunk(
                    delta=delta(
                        tool_calls=[
                            tool_fragment(
                                0,
                                call_id="call_1",
                                name="read",
                                arguments='{"path":"missing.txt"}',
                                call_type="function",
                            )
                        ]
                    )
                ),
                chunk(delta=delta(), finish_reason="tool_calls"),
            ]
        )
        second = FakeStream(
            [
                chunk(delta=delta(content="finished")),
                chunk(delta=delta(), finish_reason="stop"),
            ]
        )
        completions = FakeCompletions(first, second)
        client = SimpleNamespace(
            chat=SimpleNamespace(completions=completions)
        )
        with tempfile.TemporaryDirectory() as directory:
            agent = CodingAgent(
                client=client,
                model="deepseek-reasoner",
                provider="deepseek",
                tools=ToolRegistry(Path(directory)),
            )
            self.assertEqual(agent.run("read it"), "finished")

            assistant = completions.requests[1]["messages"][-2]
            self.assertEqual(
                assistant["reasoning_content"], "private reasoning"
            )
            agent.switch_model(
                client=client, model="gpt-test", provider="openai"
            )
            self.assertFalse(
                any("reasoning_content" in message for message in agent.messages)
            )

    def test_failed_attempt_is_not_committed_to_agent_history(self):
        client = SimpleNamespace(
            chat=SimpleNamespace(
                completions=FakeCompletions(
                    FakeStream(
                        [
                            chunk(delta=delta(content="visible partial")),
                            chunk(delta=delta(), finish_reason="length"),
                        ]
                    )
                )
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            agent = CodingAgent(
                client=client,
                model="model",
                tools=ToolRegistry(Path(directory)),
            )
            with self.assertRaises(AgentError):
                agent.run("hello")

        self.assertEqual(
            [message["role"] for message in agent.messages],
            ["system", "user"],
        )
        self.assertFalse(
            any(
                message.get("content") == "visible partial"
                for message in agent.messages
            )
        )

    def test_cancel_at_history_commit_boundary_discards_assistant(self):
        stream = FakeStream(
            [
                chunk(delta=delta(content="complete but cancelled")),
                chunk(delta=delta(), finish_reason="stop"),
            ]
        )
        client = SimpleNamespace(
            chat=SimpleNamespace(completions=FakeCompletions(stream))
        )

        class BoundaryContext:
            cancel_token = CancelToken()
            session_id = "session-1"
            task_id = "task-1"
            event_bus = EventBus()

            @staticmethod
            def commit_input(callback):
                callback()
                return True

            @staticmethod
            def commit_if_active(_callback):
                return False

        with tempfile.TemporaryDirectory() as directory:
            agent = CodingAgent(
                client=client,
                model="model",
                tools=ToolRegistry(Path(directory)),
            )
            with self.assertRaisesRegex(AgentCancelled, "history commit"):
                agent.run("hello", BoundaryContext())

        self.assertEqual(
            [message["role"] for message in agent.messages],
            ["system", "user"],
        )
        self.assertFalse(
            any(
                message.get("content") == "complete but cancelled"
                for message in agent.messages
            )
        )

    def test_agent_publishes_canonical_model_events(self):
        event_bus = EventBus()
        context = SimpleNamespace(
            event_bus=event_bus,
            session_id="session-1",
            task_id="task-1",
            cancel_token=CancelToken(),
        )
        stream = FakeStream(
            [
                chunk(delta=delta(content="hello")),
                chunk(delta=delta(), finish_reason="stop"),
            ]
        )
        client = SimpleNamespace(
            chat=SimpleNamespace(
                completions=FakeCompletions(stream)
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            agent = CodingAgent(
                client=client,
                model="model",
                tools=ToolRegistry(Path(directory)),
            )
            self.assertEqual(agent.run("hi", context), "hello")

        events = event_bus.drain()
        kinds = [event.kind for event in events]
        self.assertEqual(
            kinds,
            [
                EventKind.MODEL_REQUEST_STARTED,
                EventKind.MODEL_TEXT_DELTA,
                EventKind.MODEL_RESPONSE_VALIDATING,
                EventKind.MODEL_RESPONSE_COMMITTED,
            ],
        )
        self.assertTrue(all(event.task_id == "task-1" for event in events))
        correlation_ids = {event.correlation_id for event in events}
        self.assertEqual(len(correlation_ids), 1)
        self.assertNotIn(None, correlation_ids)

    def test_cancelled_tool_batch_keeps_history_pairs(self):
        stream = FakeStream(
            [
                chunk(
                    delta=delta(
                        tool_calls=[
                            tool_fragment(
                                0,
                                call_id="call_1",
                                name="read",
                                arguments='{"path":"file.txt"}',
                                call_type="function",
                            )
                        ]
                    )
                ),
                chunk(delta=delta(), finish_reason="tool_calls"),
            ]
        )
        token = CancelToken()
        client = SimpleNamespace(
            chat=SimpleNamespace(
                completions=FakeCompletions(stream)
            )
        )
        agent = CodingAgent(
            client=client,
            model="model",
            tools=CancellingTools(),
        )

        with self.assertRaisesRegex(AgentCancelled, "cancel during tool"):
            agent.run("read", cancel_token=token)

        self.assertEqual(
            [message["role"] for message in agent.messages],
            ["system", "user", "assistant", "tool"],
        )
        self.assertEqual(
            agent.messages[-2]["tool_calls"][0]["id"], "call_1"
        )
        self.assertEqual(agent.messages[-1]["tool_call_id"], "call_1")
        self.assertIn('"status": "cancelled"', agent.messages[-1]["content"])


if __name__ == "__main__":
    unittest.main()

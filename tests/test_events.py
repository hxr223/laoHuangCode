import threading
import unittest

from laohuangcode.events import (
    EventBus,
    EventFactory,
    EventKind,
    EventProjector,
    EventSource,
    EventSpec,
    EventValidationError,
)


class EventTests(unittest.TestCase):
    def test_envelope_and_nested_payload_are_immutable(self):
        event = EventFactory().create(
            EventKind.MODEL_TEXT_DELTA,
            source=EventSource.MODEL,
            session_id="session-1",
            task_id="task-1",
            correlation_id="request-1",
            payload={"text": "hi", "nested": {"values": [1, 2]}},
        )

        with self.assertRaises(TypeError):
            event.payload["text"] = "changed"
        with self.assertRaises(TypeError):
            event.payload["nested"]["values"] = ()
        self.assertEqual(event.payload["nested"]["values"], (1, 2))

    def test_factory_enforces_registered_spec(self):
        factory = EventFactory(
            {
                EventKind.MODEL_TEXT_DELTA: EventSpec(
                    EventKind.MODEL_TEXT_DELTA,
                    sources=frozenset({EventSource.MODEL}),
                    required_payload=frozenset({"text"}),
                )
            }
        )

        with self.assertRaises(EventValidationError):
            factory.create(
                EventKind.MODEL_TEXT_DELTA,
                source=EventSource.TOOL,
                session_id="session-1",
                payload={},
            )

    def test_default_specs_reject_user_forged_internal_events(self):
        with self.assertRaises(EventValidationError):
            EventFactory().create(
                EventKind.TOOL_STARTED,
                source=EventSource.USER,
                session_id="session-1",
            )

    def test_projector_recursively_redacts_secrets(self):
        event = EventFactory().create(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={
                "content": (
                    "curl -H 'Authorization: Bearer top-secret' "
                    "https://example.test"
                ),
                "api_key": "key",
                "headers": {"Authorization": "Bearer token"},
            },
        )

        projected = EventProjector().project(event, "web")

        self.assertEqual(projected["payload"]["api_key"], "[REDACTED]")
        self.assertEqual(
            projected["payload"]["headers"]["Authorization"], "[REDACTED]"
        )
        self.assertNotIn("top-secret", projected["payload"]["content"])

    def test_bus_assigns_strict_sequence_and_fans_out(self):
        bus = EventBus()
        observed_a = []
        observed_b = []
        unsubscribe = bus.subscribe(lambda event: observed_a.append(event.sequence))
        bus.subscribe(lambda event: observed_b.append(event.sequence))

        threads = [
            threading.Thread(
                target=lambda: bus.publish(
                    EventKind.MODEL_TEXT_DELTA,
                    source=EventSource.MODEL,
                    session_id="session-1",
                    task_id="task-1",
                    correlation_id="request-1",
                    payload={"text": "x"},
                )
            )
            for _ in range(20)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        bus.flush()

        self.assertEqual(observed_a, list(range(1, 21)))
        self.assertEqual(observed_b, observed_a)
        self.assertEqual(
            [event.sequence for event in bus.drain()], list(range(1, 21))
        )

        unsubscribe()
        bus.publish(
            EventKind.SESSION_STOPPED,
            source=EventSource.SESSION,
            session_id="session-1",
        )
        bus.flush()
        self.assertEqual(len(observed_a), 20)
        self.assertEqual(observed_b[-1], 21)

    def test_subscriber_can_publish_without_deadlocking(self):
        bus = EventBus()
        observed = []

        def subscriber(event):
            observed.append(event.kind)
            if event.kind is EventKind.INPUT_USER_MESSAGE:
                bus.publish(
                    EventKind.ROUTING_DECIDED,
                    source=EventSource.ROUTER,
                    session_id="session-1",
                    correlation_id=event.event_id,
                    payload={
                        "destination": "current_task",
                        "reason": "test callback",
                    },
                )

        bus.subscribe(subscriber)
        bus.publish(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "hello"},
        )
        bus.flush()

        self.assertEqual(
            observed,
            [EventKind.INPUT_USER_MESSAGE, EventKind.ROUTING_DECIDED],
        )

    def test_slow_subscriber_does_not_block_another_subscriber(self):
        bus = EventBus()
        slow_entered = threading.Event()
        release_slow = threading.Event()
        fast_received = threading.Event()

        def slow(_event):
            slow_entered.set()
            release_slow.wait(1)

        bus.subscribe(slow)
        bus.subscribe(lambda _event: fast_received.set())
        bus.publish(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "hello"},
        )

        self.assertTrue(slow_entered.wait(1))
        self.assertTrue(fast_received.wait(0.2))
        release_slow.set()
        bus.close()

    def test_full_slow_mailbox_never_blocks_control_publication(self):
        bus = EventBus(subscriber_mailbox_size=65)
        slow_entered = threading.Event()
        release_slow = threading.Event()
        fast_control = threading.Event()
        slow_observed = []

        def slow(event):
            slow_entered.set()
            release_slow.wait(1)
            slow_observed.append(event)

        bus.subscribe(slow)
        bus.subscribe(
            lambda event: fast_control.set()
            if event.kind is EventKind.UI_MESSAGE
            else None
        )
        bus.publish(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "start"},
        )
        self.assertTrue(slow_entered.wait(1))
        for index in range(200):
            bus.publish(
                EventKind.MODEL_TEXT_DELTA,
                source=EventSource.MODEL,
                session_id="session-1",
                task_id="task-1",
                correlation_id=f"request-{index % 2}",
                payload={"text": "x"},
            )
        bus.publish(
            EventKind.UI_MESSAGE,
            source=EventSource.SESSION,
            session_id="session-1",
            payload={"text": "control"},
        )

        self.assertTrue(fast_control.wait(0.2))
        release_slow.set()
        bus.close()
        slow_control = next(
            event
            for event in slow_observed
            if event.kind is EventKind.UI_MESSAGE
        )
        self.assertGreater(slow_control.payload["_projection_dropped"], 0)

    def test_latest_terminal_event_replaces_old_projection_backlog(self):
        bus = EventBus(subscriber_mailbox_size=65)
        entered = threading.Event()
        release = threading.Event()
        observed = []

        def slow(event):
            entered.set()
            release.wait(1)
            observed.append(event)

        bus.subscribe(slow)
        bus.publish(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "start"},
        )
        self.assertTrue(entered.wait(1))
        for index in range(70):
            bus.publish(
                EventKind.UI_MESSAGE,
                source=EventSource.SESSION,
                session_id="session-1",
                payload={"text": f"notice-{index}"},
            )
        bus.publish(
            EventKind.SESSION_STOPPED,
            source=EventSource.SESSION,
            session_id="session-1",
        )
        release.set()
        bus.close()

        stopped = next(
            event for event in observed if event.kind is EventKind.SESSION_STOPPED
        )
        self.assertGreater(stopped.payload["_projection_dropped"], 0)

    def test_projection_gap_accumulates_across_repeated_merges(self):
        bus = EventBus(subscriber_mailbox_size=67)
        entered = threading.Event()
        release = threading.Event()
        observed = []

        def slow(event):
            entered.set()
            release.wait(1)
            observed.append(event)

        bus.subscribe(slow)
        bus.publish(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "start"},
        )
        self.assertTrue(entered.wait(1))
        for index in range(2):
            bus.publish(
                EventKind.UI_MESSAGE,
                source=EventSource.SESSION,
                session_id="session-1",
                payload={"text": f"notice-{index}"},
            )
        for correlation_id in (
            "request-a",
            "request-b",
            "request-a",
            "request-b",
            "request-a",
        ):
            bus.publish(
                EventKind.MODEL_TEXT_DELTA,
                source=EventSource.MODEL,
                session_id="session-1",
                task_id="task-1",
                correlation_id=correlation_id,
                payload={"text": "x"},
            )
        release.set()
        bus.close()

        merged = next(
            event
            for event in observed
            if event.kind is EventKind.MODEL_TEXT_DELTA
            and event.correlation_id == "request-a"
        )
        self.assertEqual(merged.payload["_projection_dropped"], 2)

    def test_subscriber_can_unsubscribe_itself_without_deadlock(self):
        bus = EventBus()
        completed = threading.Event()
        holder = {}

        def callback(_event):
            holder["unsubscribe"]()
            completed.set()

        holder["unsubscribe"] = bus.subscribe(callback)
        bus.publish(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "hello"},
        )

        self.assertTrue(completed.wait(0.2))
        bus.close()

    def test_default_specs_require_model_correlation_metadata(self):
        with self.assertRaisesRegex(EventValidationError, "task_id"):
            EventFactory().create(
                EventKind.MODEL_TEXT_DELTA,
                source=EventSource.MODEL,
                session_id="session-1",
                payload={"text": "hi"},
            )

    def test_ui_feedback_shares_event_order_and_bus_closes(self):
        bus = EventBus()
        observed = []
        bus.subscribe(lambda event: observed.append(event.kind))

        bus.publish(
            EventKind.MODEL_TEXT_DELTA,
            source=EventSource.MODEL,
            session_id="session-1",
            task_id="task-1",
            correlation_id="request-1",
            payload={"text": "earlier"},
        )
        bus.publish(
            EventKind.UI_MESSAGE,
            source=EventSource.SESSION,
            session_id="session-1",
            payload={"text": "later"},
        )
        bus.close()

        self.assertEqual(
            observed,
            [EventKind.MODEL_TEXT_DELTA, EventKind.UI_MESSAGE],
        )
        with self.assertRaisesRegex(RuntimeError, "closed"):
            bus.publish(
                EventKind.UI_MESSAGE,
                source=EventSource.SESSION,
                session_id="session-1",
                payload={"text": "too late"},
            )


if __name__ == "__main__":
    unittest.main()

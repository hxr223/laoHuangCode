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

    def test_ui_feedback_shares_event_order_and_bus_closes(self):
        bus = EventBus()
        observed = []
        bus.subscribe(lambda event: observed.append(event.kind))

        bus.publish(
            EventKind.MODEL_TEXT_DELTA,
            source=EventSource.MODEL,
            session_id="session-1",
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

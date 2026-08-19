import unittest

from laohuangcode.events import EventFactory, EventKind, EventSource
from laohuangcode.routing import (
    DeadLetterQueue,
    EventRouter,
    PendingQueue,
    RouteDestination,
    RouteStrategy,
    RouteTiming,
    RoutedEvent,
    Scheduler,
    TaskRegistry,
    TaskState,
)


def user_event(content, *, task_id=None, strategy=None):
    payload = {"content": content}
    if strategy:
        payload["strategy"] = strategy
    return EventFactory().create(
        EventKind.INPUT_USER_MESSAGE,
        source=EventSource.USER,
        session_id="session-1",
        task_id=task_id,
        payload=payload,
    )


class RouterTests(unittest.TestCase):
    def setUp(self):
        self.registry = TaskRegistry()
        self.registry.register("task-1")

    def test_layers_short_circuit_and_cancel_is_final(self):
        classifier_calls = []
        router = EventRouter(
            self.registry,
            semantic_classifier=lambda event, active: (
                classifier_calls.append(event.event_id) or RouteStrategy.STEER
            ),
        )

        metadata = router.route(user_event("fix it", task_id="task-1"))
        self.assertEqual(metadata.decision.layer, 1)
        self.assertEqual(metadata.decision.destination, RouteDestination.PENDING)
        self.assertEqual(classifier_calls, [])

        ambiguous = router.route(user_event("also consider tests"))
        self.assertEqual(ambiguous.decision.layer, 3)
        self.assertEqual(ambiguous.decision.strategy, RouteStrategy.STEER)
        self.assertEqual(len(classifier_calls), 1)

        cancel = EventFactory().create(
            EventKind.INPUT_CANCEL_REQUESTED,
            source=EventSource.USER,
            session_id="session-1",
        )
        cancellation = router.route(cancel)
        self.assertEqual(cancellation.decision.layer, 4)
        self.assertEqual(cancellation.decision.destination, RouteDestination.CONTROL)
        self.assertEqual(cancellation.decision.strategy, RouteStrategy.CANCEL)
        self.assertEqual(len(classifier_calls), 1)

    def test_cancelling_task_holds_ordinary_input(self):
        self.registry.transition("task-1", TaskState.CANCELLING)
        decision = EventRouter(self.registry).route(user_event("one more thing"))

        self.assertEqual(decision.decision.destination, RouteDestination.HELD)
        self.assertEqual(decision.decision.timing, RouteTiming.AFTER_CANCEL)

    def test_pending_queue_drains_one_compatible_snapshot_in_order(self):
        queue = PendingQueue()
        router = EventRouter(self.registry)
        first = router.route(user_event("first", strategy="steer"))
        follow_up = router.route(user_event("later", strategy="follow_up"))
        second = router.route(user_event("second", strategy="steer"))
        for item in (first, follow_up, second):
            queue.put(item)

        drained = queue.drain_compatible(task_id="task-1")

        self.assertEqual(
            [item.event.payload["content"] for item in drained],
            ["first", "second"],
        )
        self.assertEqual(
            [item.event.payload["content"] for item in queue.snapshot()],
            ["later"],
        )

    def test_queues_are_bounded(self):
        queue = PendingQueue(max_items=1)
        router = EventRouter(self.registry)
        queue.put(router.route(user_event("first", strategy="steer")))
        with self.assertRaises(OverflowError):
            queue.put(router.route(user_event("second", strategy="steer")))

    def test_pending_queue_enforces_estimated_token_budget(self):
        queue = PendingQueue(max_items=10, max_estimated_tokens=2)
        router = EventRouter(self.registry)

        with self.assertRaisesRegex(OverflowError, "token budget"):
            queue.put(
                router.route(user_event("this message is too large", strategy="steer"))
            )

    def test_scheduler_sends_capacity_rejections_to_dead_letters(self):
        pending = PendingQueue(max_items=1)
        dead_letters = DeadLetterQueue()
        scheduler = Scheduler(pending=pending, dead_letters=dead_letters)
        router = EventRouter(self.registry)
        scheduler.schedule(router.route(user_event("first", strategy="steer")))

        result = scheduler.schedule(
            router.route(user_event("second", strategy="steer"))
        )

        self.assertTrue(result.rejected)
        self.assertEqual(len(dead_letters), 1)


if __name__ == "__main__":
    unittest.main()

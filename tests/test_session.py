import threading
import unittest

from laohuangcode.cancellation import CancellationError
from laohuangcode.events import EventKind, EventSource
from laohuangcode.routing import RouteDestination, TaskState
from laohuangcode.session import AgentSession


class AgentSessionTests(unittest.TestCase):
    def test_pending_messages_are_drained_once_as_one_model_input(self):
        entered = threading.Event()
        release = threading.Event()
        calls = []

        def runner(content, *, context):
            calls.append(content)
            if len(calls) == 1:
                entered.set()
                self.assertTrue(release.wait(1))
            return f"answer-{len(calls)}"

        session = AgentSession(runner, session_id="session-1")
        submission = session.submit_input("first")
        self.assertTrue(entered.wait(1))
        session.submit_input("second", strategy="steer")
        session.submit_input("third", strategy="steer")
        release.set()

        self.assertTrue(session.wait_for_idle(1))
        self.assertEqual(calls[0], "first")
        self.assertEqual(len(calls), 2)
        self.assertIn("second", calls[1])
        self.assertIn("third", calls[1])
        self.assertIn("Please handle all", calls[1])
        self.assertEqual(
            session.task_registry.get(submission.task_id).state,
            TaskState.COMPLETED,
        )

    def test_cancel_stops_task_and_moves_pending_to_held(self):
        entered = threading.Event()

        def runner(_content, *, context):
            entered.set()
            context.cancel_token.wait(1)
            context.cancel_token.throw_if_cancelled()
            raise AssertionError("cancellation should have interrupted the runner")

        session = AgentSession(runner, session_id="session-1")
        submission = session.submit_input("long task")
        self.assertTrue(entered.wait(1))
        session.submit_input("do this afterward", strategy="follow_up")

        self.assertTrue(session.request_cancel("test cancellation"))
        self.assertTrue(session.wait_for_idle(1))
        record = session.task_registry.get(submission.task_id)
        self.assertEqual(record.state, TaskState.CANCELLED)
        self.assertEqual(record.cancel_token.reason, "test cancellation")
        self.assertEqual(session.pending_count, 0)
        self.assertEqual(session.held_count, 1)

        events = session.event_bus.drain()
        self.assertIn(EventKind.TASK_CANCELLED, [event.kind for event in events])

    def test_cancel_wins_over_task_completion_at_the_return_boundary(self):
        entered = threading.Event()
        release = threading.Event()

        def runner(_content, *, context):
            entered.set()
            self.assertTrue(release.wait(1))
            return "must not commit"

        session = AgentSession(runner, session_id="session-1")
        submission = session.submit_input("work")
        self.assertTrue(entered.wait(1))
        self.assertTrue(session.request_cancel("boundary cancel"))
        release.set()

        self.assertTrue(session.wait_for_idle(1))
        record = session.task_registry.get(submission.task_id)
        self.assertEqual(record.state, TaskState.CANCELLED)
        kinds = [event.kind for event in session.event_bus.drain()]
        self.assertIn(EventKind.TASK_CANCELLED, kinds)
        self.assertNotIn(EventKind.TASK_COMPLETED, kinds)

    def test_cancel_after_pending_claim_moves_batch_to_held(self):
        first_entered = threading.Event()
        release_first = threading.Event()
        claimed_entered = threading.Event()

        def runner(content, *, context):
            if "first" == content:
                first_entered.set()
                self.assertTrue(release_first.wait(1))
                return "first done"
            claimed_entered.set()
            context.cancel_token.wait(1)
            context.cancel_token.throw_if_cancelled()
            return "must not finish"

        session = AgentSession(runner, session_id="session-1")
        submission = session.submit_input("first")
        self.assertTrue(first_entered.wait(1))
        session.submit_input("claimed pending", strategy="steer")
        release_first.set()
        self.assertTrue(claimed_entered.wait(1))

        self.assertTrue(session.request_cancel("cancel claimed batch"))
        self.assertTrue(session.wait_for_idle(1))
        self.assertEqual(
            session.task_registry.get(submission.task_id).state,
            TaskState.CANCELLED,
        )
        self.assertEqual(session.pending_count, 0)
        self.assertEqual(session.held_count, 1)
        held = session.held.drain()
        self.assertIn("claimed pending", held[0].event.payload["content"])

    def test_cancel_after_pending_history_commit_rolls_back_and_holds(self):
        first_entered = threading.Event()
        release_first = threading.Event()
        history_committed = threading.Event()
        history = []

        def runner(content, *, context):
            if content == "first":
                first_entered.set()
                self.assertTrue(release_first.wait(1))
                batch = context.safe_point()
                message = {"role": "user", "content": batch.content}
                self.assertTrue(
                    context.commit_pending(
                        batch,
                        lambda: history.append(message),
                        rollback=lambda: history.pop(),
                    )
                )
                history_committed.set()
                context.cancel_token.wait(1)
                context.cancel_token.throw_if_cancelled()
            return "done"

        session = AgentSession(runner, session_id="session-1")
        submission = session.submit_input("first")
        self.assertTrue(first_entered.wait(1))
        session.submit_input("not sent yet", strategy="steer")
        release_first.set()
        self.assertTrue(history_committed.wait(1))
        self.assertEqual(len(history), 1)

        self.assertTrue(session.request_cancel("pre-request cancel"))
        self.assertTrue(session.wait_for_idle(1))
        self.assertEqual(history, [])
        self.assertEqual(session.held_count, 1)
        self.assertEqual(
            session.task_registry.get(submission.task_id).state,
            TaskState.CANCELLED,
        )

    def test_repeated_safe_point_does_not_drop_a_second_batch(self):
        entered = threading.Event()
        release = threading.Event()
        first_claimed = threading.Event()
        release_second = threading.Event()

        def runner(_content, *, context):
            entered.set()
            self.assertTrue(release.wait(1))
            self.assertTrue(context.safe_point())
            first_claimed.set()
            self.assertTrue(release_second.wait(1))
            context.safe_point()
            return "unreachable"

        session = AgentSession(runner, session_id="session-1")
        submission = session.submit_input("first")
        self.assertTrue(entered.wait(1))
        session.submit_input("pending one", strategy="steer")
        release.set()
        self.assertTrue(first_claimed.wait(1))
        session.submit_input("pending two", strategy="steer")
        release_second.set()

        self.assertTrue(session.wait_for_idle(1))
        self.assertEqual(
            session.task_registry.get(submission.task_id).state,
            TaskState.FAILED,
        )
        self.assertEqual(session.pending_count, 0)
        self.assertEqual(session.held_count, 2)

    def test_slash_command_is_local_control_and_does_not_start_task(self):
        session = AgentSession(
            lambda _content: self.fail("runner should not be called"),
            session_id="session-1",
        )

        submission = session.submit_input("/model")

        self.assertTrue(submission.control)
        self.assertIsNone(submission.task_id)
        self.assertIsNone(session.active_task)

    def test_internal_model_callback_passes_through_router(self):
        def runner(_content, context):
            context.publish(
                EventKind.MODEL_TEXT_DELTA,
                source=EventSource.MODEL,
                correlation_id="request-1",
                payload={"request_id": "request-1", "text": "hello"},
            )
            return "done"

        session = AgentSession(runner, session_id="session-1")
        session.submit_input("start")
        self.assertTrue(session.wait_for_idle(1))

        events = session.event_bus.drain()
        model_event = next(
            event for event in events if event.kind is EventKind.MODEL_TEXT_DELTA
        )
        route_event = next(
            event
            for event in events
            if event.kind is EventKind.ROUTING_DECIDED
            and event.correlation_id == model_event.event_id
        )
        self.assertLess(route_event.sequence, model_event.sequence)

    def test_input_classified_during_cancel_is_held_not_auto_started(self):
        task_started = threading.Event()
        classifier_entered = threading.Event()
        release_classifier = threading.Event()
        calls = []

        def runner(content, context):
            calls.append(content)
            task_started.set()
            context.cancel_token.wait(1)
            context.cancel_token.throw_if_cancelled()
            return "done"

        def classifier(_event, _active):
            classifier_entered.set()
            self.assertTrue(release_classifier.wait(1))
            return "follow_up"

        session = AgentSession(
            runner,
            session_id="session-1",
            semantic_classifier=classifier,
        )
        session.submit_input("first")
        self.assertTrue(task_started.wait(1))
        submissions = []
        submitter = threading.Thread(
            target=lambda: submissions.append(session.submit_input("second"))
        )
        submitter.start()
        self.assertTrue(classifier_entered.wait(1))

        self.assertTrue(session.request_cancel())
        release_classifier.set()
        submitter.join(1)
        self.assertTrue(session.wait_for_idle(1))

        self.assertEqual(calls, ["first"])
        self.assertEqual(session.held_count, 1)
        self.assertEqual(
            submissions[0].routed.decision.destination,
            RouteDestination.HELD,
        )


if __name__ == "__main__":
    unittest.main()

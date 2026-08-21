import json
from types import SimpleNamespace
import unittest

from laohuangcode.events import EventFactory, EventKind, EventSource
from laohuangcode.routing import RouteStrategy, TaskRegistry
from laohuangcode.semantic_classifier import SmallModelSemanticClassifier


class _Completions:
    def __init__(self, body):
        self.body = body
        self.requests = []

    def create(self, **request):
        self.requests.append(request)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    message=SimpleNamespace(content=json.dumps(self.body))
                )
            ]
        )


class SemanticClassifierTests(unittest.TestCase):
    def test_uses_one_no_history_request_and_accepts_confident_json(self):
        completions = _Completions(
            {"strategy": "steer", "confidence": 0.91}
        )
        client = SimpleNamespace(
            chat=SimpleNamespace(completions=completions)
        )
        classifier = SmallModelSemanticClassifier(
            client=client, model="router-model"
        )
        registry = TaskRegistry()
        active = registry.register("task-1")
        event = EventFactory().create(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "改成另一种实现"},
        )

        decision = classifier(event, active)

        self.assertIsNotNone(decision)
        self.assertEqual(decision.strategy, RouteStrategy.STEER)
        self.assertEqual(len(completions.requests[0]["messages"]), 2)
        self.assertEqual(completions.requests[0]["timeout"], 3.0)

    def test_low_confidence_or_invalid_output_falls_back(self):
        completions = _Completions(
            {"strategy": "follow_up", "confidence": 0.2}
        )
        classifier = SmallModelSemanticClassifier(
            client=SimpleNamespace(
                chat=SimpleNamespace(completions=completions)
            ),
            model="router-model",
        )
        registry = TaskRegistry()
        active = registry.register("task-1")
        event = EventFactory().create(
            EventKind.INPUT_USER_MESSAGE,
            source=EventSource.USER,
            session_id="session-1",
            payload={"content": "还有一个想法"},
        )

        self.assertIsNone(classifier(event, active))


if __name__ == "__main__":
    unittest.main()

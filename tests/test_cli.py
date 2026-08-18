from contextlib import redirect_stderr
import io
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from laohuangcode.__main__ import main, run_repl


class ReplTests(unittest.TestCase):
    def test_user_can_chat_until_exit(self):
        inputs = iter(["hello", "/exit"])
        outputs = []
        agent = SimpleNamespace(
            inputs=[],
            run=lambda text: agent.inputs.append(text) or "hi there",
        )

        run_repl(
            agent,
            input_fn=lambda prompt: next(inputs),
            output_fn=outputs.append,
        )

        self.assertEqual(agent.inputs, ["hello"])
        self.assertTrue(any("hi there" in output for output in outputs))

    def test_startup_explains_missing_configuration(self):
        errors = io.StringIO()

        with patch.dict(os.environ, {}, clear=True), redirect_stderr(errors):
            status = main()

        self.assertEqual(status, 2)
        self.assertIn("OPENAI_API_KEY, OPENAI_MODEL", errors.getvalue())


if __name__ == "__main__":
    unittest.main()

import os
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import unittest
from unittest.mock import patch

from laohuangcode.tools import ToolRegistry


class ToolRegistryTests(unittest.TestCase):
    def test_user_can_write_then_read_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = ToolRegistry(Path(directory))

            written = tools.execute(
                "write", {"path": "notes/hello.txt", "content": "hello\n"}
            )
            read = tools.execute("read", {"path": "notes/hello.txt"})

            self.assertTrue(written["ok"])
            self.assertEqual(read, {"ok": True, "content": "hello\n"})

    def test_file_tools_block_parent_directory_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            root.mkdir()
            outside = base / "outside.txt"
            outside.write_text("secret", encoding="utf-8")
            tools = ToolRegistry(root)

            read = tools.execute("read", {"path": "../outside.txt"})
            write = tools.execute(
                "write", {"path": "../created.txt", "content": "escaped"}
            )

            self.assertFalse(read["ok"])
            self.assertFalse(write["ok"])
            self.assertFalse((base / "created.txt").exists())

    def test_file_tools_block_symlink_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            outside = base / "outside"
            root.mkdir()
            outside.mkdir()
            (root / "link").symlink_to(outside, target_is_directory=True)
            tools = ToolRegistry(root)

            result = tools.execute(
                "write", {"path": "link/escaped.txt", "content": "escaped"}
            )

            self.assertFalse(result["ok"])
            self.assertFalse((outside / "escaped.txt").exists())

    def test_user_can_replace_one_exact_text_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "app.py").write_text("answer = 41\n", encoding="utf-8")
            tools = ToolRegistry(root)

            result = tools.execute(
                "edit",
                {
                    "path": "app.py",
                    "old_text": "answer = 41",
                    "new_text": "answer = 42",
                },
            )

            self.assertTrue(result["ok"])
            self.assertEqual(
                (root / "app.py").read_text(encoding="utf-8"), "answer = 42\n"
            )

    def test_edit_refuses_missing_or_ambiguous_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "items.txt"
            original = "same\nsame\n"
            path.write_text(original, encoding="utf-8")
            tools = ToolRegistry(root)

            missing = tools.execute(
                "edit",
                {"path": "items.txt", "old_text": "absent", "new_text": "new"},
            )
            ambiguous = tools.execute(
                "edit",
                {"path": "items.txt", "old_text": "same", "new_text": "new"},
            )

            self.assertFalse(missing["ok"])
            self.assertFalse(ambiguous["ok"])
            self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_bash_runs_in_project_root_and_returns_process_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools = ToolRegistry(root)

            result = tools.execute("bash", {"command": "pwd; printf problem >&2"})

            self.assertTrue(result["ok"])
            self.assertEqual(result["exit_code"], 0)
            self.assertEqual(result["stdout"].strip(), str(root.resolve()))
            self.assertEqual(result["stderr"], "problem")

    def test_bash_timeout_returns_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = ToolRegistry(Path(directory), bash_timeout=0.01)

            result = tools.execute("bash", {"command": "sleep 1"})

            self.assertFalse(result["ok"])
            self.assertIn("timed out", result["error"].lower())

    def test_long_tool_output_is_truncated_with_a_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "large.txt").write_text("abcdefghijklmno", encoding="utf-8")
            tools = ToolRegistry(root, max_output_chars=10)

            result = tools.execute("read", {"path": "large.txt"})

            self.assertEqual(result["content"][:10], "abcdefghij")
            self.assertIn("truncated", result["content"])

    def test_bash_does_not_receive_model_api_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = ToolRegistry(Path(directory))

            with patch.dict(
                os.environ,
                {
                    "OPENAI_API_KEY": "openai-secret",
                    "DEEPSEEK_API_KEY": "deepseek-secret",
                    "LAOHUANG_API_KEY": "custom-secret",
                },
            ):
                result = tools.execute(
                    "bash",
                    {
                        "command": (
                            "printf '%s|%s|%s' \"$OPENAI_API_KEY\" "
                            "\"$DEEPSEEK_API_KEY\" \"$LAOHUANG_API_KEY\""
                        )
                    },
                )

            self.assertTrue(result["ok"])
            self.assertEqual(result["stdout"], "||")

    def test_writes_to_the_same_file_are_serialized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools = ToolRegistry(root)
            original_write_text = Path.write_text
            counter_lock = threading.Lock()
            active_writes = 0
            maximum_active_writes = 0

            def tracked_write_text(path, *args, **kwargs):
                nonlocal active_writes, maximum_active_writes
                with counter_lock:
                    active_writes += 1
                    maximum_active_writes = max(
                        maximum_active_writes, active_writes
                    )
                try:
                    time.sleep(0.05)
                    return original_write_text(path, *args, **kwargs)
                finally:
                    with counter_lock:
                        active_writes -= 1

            with patch.object(Path, "write_text", tracked_write_text):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    results = list(
                        executor.map(
                            lambda content: tools.execute(
                                "write",
                                {"path": "shared.txt", "content": content},
                            ),
                            ["first", "second"],
                        )
                    )

            self.assertTrue(all(result["ok"] for result in results))
            self.assertEqual(maximum_active_writes, 1)

    def test_writes_to_different_files_can_run_concurrently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tools = ToolRegistry(root)
            original_write_text = Path.write_text
            counter_lock = threading.Lock()
            active_writes = 0
            maximum_active_writes = 0

            def tracked_write_text(path, *args, **kwargs):
                nonlocal active_writes, maximum_active_writes
                with counter_lock:
                    active_writes += 1
                    maximum_active_writes = max(
                        maximum_active_writes, active_writes
                    )
                try:
                    time.sleep(0.05)
                    return original_write_text(path, *args, **kwargs)
                finally:
                    with counter_lock:
                        active_writes -= 1

            with patch.object(Path, "write_text", tracked_write_text):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    results = list(
                        executor.map(
                            lambda item: tools.execute(
                                "write",
                                {"path": item[0], "content": item[1]},
                            ),
                            [("first.txt", "first"), ("second.txt", "second")],
                        )
                    )

            self.assertTrue(all(result["ok"] for result in results))
            self.assertEqual(maximum_active_writes, 2)

    def test_edits_to_the_same_file_do_not_lose_updates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "shared.txt"
            path.write_text("one\ntwo\n", encoding="utf-8")
            tools = ToolRegistry(root)
            original_read_text = Path.read_text

            def slow_read_text(target, *args, **kwargs):
                content = original_read_text(target, *args, **kwargs)
                if target.name == "shared.txt":
                    time.sleep(0.05)
                return content

            edits = [
                {"path": "shared.txt", "old_text": "one", "new_text": "ONE"},
                {"path": "shared.txt", "old_text": "two", "new_text": "TWO"},
            ]
            with patch.object(Path, "read_text", slow_read_text):
                with ThreadPoolExecutor(max_workers=2) as executor:
                    results = list(
                        executor.map(
                            lambda arguments: tools.execute("edit", arguments),
                            edits,
                        )
                    )

            self.assertTrue(all(result["ok"] for result in results))
            self.assertEqual(path.read_text(encoding="utf-8"), "ONE\nTWO\n")


if __name__ == "__main__":
    unittest.main()

import unittest

from laohuangcode.permissions import PermissionGate


class PermissionGateTests(unittest.TestCase):
    def test_read_is_automatic_but_mutating_tools_require_approval(self):
        prompts = []
        answers = iter(["n", "y"])
        gate = PermissionGate(
            prompt=lambda name, arguments: prompts.append((name, arguments))
            or next(answers)
        )

        read_allowed = gate.authorize("read", {"path": "README.md"})
        bash_allowed = gate.authorize("bash", {"command": "rm file.txt"})
        edit_allowed = gate.authorize(
            "edit", {"path": "app.py", "old_text": "x", "new_text": "y"}
        )

        self.assertTrue(read_allowed)
        self.assertFalse(bash_allowed)
        self.assertTrue(edit_allowed)
        self.assertEqual([name for name, _ in prompts], ["bash", "edit"])

    def test_allow_all_applies_to_the_rest_of_the_session(self):
        answers = iter(["a"])
        gate = PermissionGate(prompt=lambda _name, _args: next(answers))

        self.assertTrue(gate.authorize("write", {"path": "one.txt"}))
        self.assertTrue(gate.authorize("bash", {"command": "true"}))

    def test_dangerous_bypass_skips_the_prompt(self):
        gate = PermissionGate(
            prompt=lambda _name, _args: self.fail("prompt should not be called"),
            dangerously_skip_permissions=True,
        )

        self.assertTrue(gate.authorize("bash", {"command": "true"}))


if __name__ == "__main__":
    unittest.main()

import unittest

from laohuangcode.cancellation import CancelToken, CancellationError


class CancelTokenTests(unittest.TestCase):
    def test_cancel_is_idempotent_and_notifies_once(self):
        token = CancelToken()
        reasons = []
        token.register(reasons.append)

        self.assertTrue(token.cancel("stop now"))
        self.assertFalse(token.cancel("second reason"))
        self.assertTrue(token.is_cancelled())
        self.assertEqual(token.reason, "stop now")
        self.assertEqual(reasons, ["stop now"])
        with self.assertRaisesRegex(CancellationError, "stop now"):
            token.throw_if_cancelled()

    def test_late_registration_runs_immediately_and_unregister_works(self):
        token = CancelToken()
        removed = []
        unregister = token.register(removed.append)
        unregister()
        token.cancel("done")
        self.assertEqual(removed, [])

        late = []
        token.register(late.append)
        self.assertEqual(late, ["done"])


if __name__ == "__main__":
    unittest.main()

from urllib.error import HTTPError, URLError
from unittest import mock
import unittest
import json

from scripts import check_npm_unpublished


class _RegistryResponse:
    status = 200

    def __init__(self, metadata=None):
        self.metadata = metadata or {"version": "1.2.3"}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.metadata).encode()


class NpmReleaseCheckTests(unittest.TestCase):
    def test_existing_version_is_reported_as_published(self):
        with mock.patch.object(
            check_npm_unpublished,
            "urlopen",
            return_value=_RegistryResponse(),
        ):
            self.assertTrue(
                check_npm_unpublished.is_published("laohuang", "1.2.3")
            )

    def test_registry_404_means_version_is_available(self):
        not_found = HTTPError(
            "https://registry.npmjs.org/laohuang/1.2.3",
            404,
            "Not Found",
            None,
            None,
        )
        with mock.patch.object(
            check_npm_unpublished,
            "urlopen",
            side_effect=not_found,
        ):
            self.assertFalse(
                check_npm_unpublished.is_published("laohuang", "1.2.3")
            )

    def test_registry_failures_do_not_look_like_available_versions(self):
        with mock.patch.object(
            check_npm_unpublished,
            "urlopen",
            side_effect=URLError("offline"),
        ):
            with self.assertRaisesRegex(RuntimeError, "Could not reach"):
                check_npm_unpublished.is_published("laohuang", "1.2.3")

    def test_latest_version_is_read_from_registry_metadata(self):
        with mock.patch.object(
            check_npm_unpublished,
            "urlopen",
            return_value=_RegistryResponse({"version": "2.4.6"}),
        ):
            self.assertEqual(
                check_npm_unpublished.latest_published_version("laohuang"),
                "2.4.6",
            )

    def test_stable_versions_are_ordered_numerically(self):
        self.assertGreater(
            check_npm_unpublished.stable_version_tuple("0.10.0"),
            check_npm_unpublished.stable_version_tuple("0.9.9"),
        )


if __name__ == "__main__":
    unittest.main()

# The unit test of the listener of the markdown.send and markdown.builder steps of the recipe runner (recipe.py): a step
# that fails before a client connects ends its listener thread by an event, a connection of the step, and a step
# without the models of ORM_PYTHON_BIND_MODELS states the missing variable before it starts a listener.
import os
import unittest
from unittest import mock

from . import recipe, testcase


class _NoConnection:
    """Models whose connect fails before it opens a connection."""

    def connect(self, _dsn: str):
        raise ConnectionError("no connection is opened")


class SendListenerTest(unittest.TestCase):
    def _started(self):
        """A patch of the listener start that records the listener threads of the steps that run under it."""
        threads: list = []
        start = recipe._start_send_listener

        def recording(received: list):
            listener, thread = start(received)
            threads.append(thread)
            return listener, thread

        return threads, mock.patch.object(recipe, "_start_send_listener", recording)

    def _without_models(self):
        return (
            mock.patch.dict(os.environ, {"ORM_PYTHON_BIND_MODELS": ""}),
            mock.patch.dict(recipe.BIND_MODELS, clear=True),
        )

    def test_send_without_models_starts_no_listener(self) -> None:
        threads, started = self._started()
        environment, models = self._without_models()
        with started, environment, models:
            with self.assertRaisesRegex(
                AssertionError, "ORM_PYTHON_BIND_MODELS names no model directory"
            ):
                recipe._send({"expect": {"error": "CONFIG"}})
        self.assertEqual(threads, [])

    def test_builder_without_models_starts_no_listener(self) -> None:
        threads, started = self._started()
        environment, models = self._without_models()
        with started, environment, models:
            with self.assertRaisesRegex(
                AssertionError, "ORM_PYTHON_BIND_MODELS names no model directory"
            ):
                recipe._markdown_builder({"calls": [], "expect": {}}, recipe.NONE)
        self.assertEqual(threads, [])

    def test_send_that_opens_no_connection_ends_its_listener(self) -> None:
        threads, started = self._started()
        with started, mock.patch.object(recipe, "_bind_models", _NoConnection):
            with self.assertRaisesRegex(ConnectionError, "no connection is opened"):
                recipe._send({"expect": {"error": "CONFIG"}})
        self.assertEqual([thread.is_alive() for thread in threads], [False])

    def test_builder_that_opens_no_connection_ends_its_listener(self) -> None:
        threads, started = self._started()
        with started, mock.patch.object(recipe, "_bind_models", _NoConnection):
            with self.assertRaisesRegex(ConnectionError, "no connection is opened"):
                recipe._markdown_builder({"calls": [], "expect": {}}, recipe.NONE)
        self.assertEqual([thread.is_alive() for thread in threads], [False])


if __name__ == "__main__":
    testcase.main()

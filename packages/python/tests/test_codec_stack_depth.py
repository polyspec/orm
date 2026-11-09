# codec stack depth: a value stage returns the same value and refuses with the same rule whatever the depth of its caller
# (COD-70, COD-71). A Python value stage recurses on the Python stack, so codec.py runs a call whose caller leaves fewer
# frames than the stage takes on a thread of its own; each stage is called here at 256 levels and at 257 from a caller
# about 900 frames deep, which reaches that thread, and from a caller that leaves the stage just its budget, which runs on
# the caller's stack and so holds the budget of _STAGE_FRAMES. The recursion limit is a property of the Python runtime, so
# this test is native (docs/spec/feature-coverage.md FCV-2).
# Requirements: COD-70, COD-71.
import decimal
import sys
import unittest
from unittest import mock

from polyspec.orm import codec
from polyspec.orm.styled_value import StyledValue

from . import testcase


def nested_list(levels: int) -> list:
    value: list = []
    for _ in range(levels - 1):
        value = [value]
    return value


def nested_dict(levels: int, innermost=None):
    value = {} if innermost is None else innermost
    for _ in range(levels - 1):
        value = {"a": value}
    return value


def depth() -> int:
    frame, count = sys._getframe(1), 0
    while frame is not None:
        frame, count = frame.f_back, count + 1
    return count


def at_depth(frames: int, call):
    """call() from a caller frames deep."""
    if depth() < frames:
        return at_depth(frames, call)
    return call()


def serialized(levels: int) -> str:
    return "a:1:{i:0;" * (levels - 1) + "a:0:{}" + "}" * (levels - 1)


def serialized_map(levels: int) -> str:
    return 'a:1:{s:1:"a";' * (levels - 1) + "a:0:{}" + "}" * (levels - 1)


YAML_256 = None


def yaml_256() -> str:
    # The text of the yaml writer for 256 levels of lists, written at the depth of this module, which leaves it every
    # frame; the cases compare the text written from the other depths with it.
    global YAML_256
    if YAML_256 is None:
        YAML_256 = codec.encode(["yaml"], StyledValue.value(nested_list(256)))
    return YAML_256


def value_of(state):
    return state.payload()


# (name, stage, direction, call at 256 levels, its exact result, call at 257 levels, its exact rule text)
CASES = [
    (
        "ordered_json encode",
        "ordered_json",
        1,
        lambda: codec.encode(["ordered_json"], StyledValue.value(nested_list(256))),
        "[" * 256 + "]" * 256,
        lambda: codec.encode(["ordered_json"], StyledValue.value(nested_dict(257))),
        "CODEC_ENCODE: json: value nesting exceeds 256 levels",
    ),
    (
        "ordered_json_value",
        "ordered_json",
        1,
        lambda: codec.ordered_json_value(nested_list(256)).raw,
        "[" * 256 + "]" * 256,
        lambda: codec.ordered_json_value(nested_list(257)),
        "CODEC_ENCODE: json: value nesting exceeds 256 levels",
    ),
    (
        "ordered_json decode",
        "ordered_json",
        0,
        lambda: value_of(codec.decode(["ordered_json"], "[" * 256 + "]" * 256)).raw,
        "[" * 256 + "]" * 256,
        lambda: codec.decode(["ordered_json"], "[" * 257 + "]" * 257),
        "CODEC_DECODE: json: value nesting exceeds 256 levels",
    ),
    (
        "serialize encode",
        "serialize",
        1,
        lambda: codec.encode(["serialize"], StyledValue.value(nested_list(256))),
        serialized(256),
        lambda: codec.encode(["serialize"], StyledValue.value(nested_dict(257))),
        "CODEC_ENCODE: serialize: value nesting exceeds 256 levels",
    ),
    (
        "php_serialize",
        "serialize",
        1,
        lambda: codec.php_serialize(nested_dict(256)),
        serialized_map(256),
        lambda: codec.php_serialize(nested_list(257)),
        "CODEC_ENCODE: serialize: value nesting exceeds 256 levels",
    ),
    (
        "serialize decode",
        "serialize",
        0,
        lambda: value_of(codec.decode(["serialize"], serialized_map(256))),
        # An empty array is a list (a sequential array), the innermost value of serialized_map.
        nested_dict(256, []),
        lambda: codec.decode(["serialize"], serialized(257)),
        "CODEC_DECODE: serialize: value nesting exceeds 256 levels",
    ),
    (
        "yaml encode",
        "yaml",
        1,
        lambda: codec.encode(["yaml"], StyledValue.value(nested_list(256))),
        None,
        lambda: codec.encode(["yaml"], StyledValue.value(nested_list(257))),
        "CODEC_ENCODE: yaml: value nesting exceeds 256 levels",
    ),
    (
        "yaml decode",
        "yaml",
        0,
        lambda: value_of(
            codec.decode(["yaml"], "{a: " * 255 + "{}" + "}" * 255 + "\n")
        ),
        nested_dict(256),
        lambda: codec.decode(["yaml"], "- " * 256 + "[]\n"),
        "CODEC_DECODE: yaml: value nesting exceeds 256 levels",
    ),
    (
        "yaml decode before a collection key",
        "yaml",
        0,
        lambda: codec.decode(["yaml"], "[" * 255 + "{[x]: 1}" + "]" * 255 + "\n"),
        "CODEC_DECODE: yaml: map keys must be scalar strings",
        lambda: codec.decode(["yaml"], "{a: " * 256 + "{[x]: 1}" + "}" * 256 + "\n"),
        "CODEC_DECODE: yaml: value nesting exceeds 256 levels",
    ),
]


class CodecStackDepthTest(unittest.TestCase):
    def outcome(self, call):
        try:
            return call()
        except codec.CodecError as error:
            return str(error)

    def check(self, frames_of, use_thread: bool):
        for name, stage, direction, call, result, refused, rule in CASES:
            frames = frames_of(codec._STAGE_FRAMES[stage][direction])
            with self.subTest(name, frames=frames):
                expected = yaml_256() if result is None else result
                if use_thread:
                    got = at_depth(frames, lambda: self.outcome(call))
                    text = at_depth(frames, lambda: self.outcome(refused))
                else:
                    # The caller leaves the stage its budget, so the call runs on the caller's stack.
                    with mock.patch.object(
                        codec, "ThreadPoolExecutor", side_effect=AssertionError
                    ):
                        got = at_depth(frames, lambda: self.outcome(call))
                        text = at_depth(frames, lambda: self.outcome(refused))
                self.assertEqual(got, expected)
                self.assertEqual(text, rule)

    def test_a_deep_caller_gets_the_same_result_and_rule(self):
        self.check(lambda budget: 900, True)

    def test_a_caller_that_leaves_the_budget_runs_the_stage_on_its_stack(self):
        # sys._getframe counts the frames above it, so a caller at limit - budget leaves the stage exactly its budget,
        # with a few frames of this harness inside it.
        self.check(lambda budget: sys.getrecursionlimit() - budget - 8, False)

    def test_the_thread_reads_no_decimal_context_of_the_caller(self):
        # A float of serialize is written by its digits, not by the decimal context of the thread that writes it.
        with decimal.localcontext(decimal.Context(prec=3)):
            near = codec.encode(["serialize"], StyledValue.value([0.123456789]))
            deep = at_depth(
                900,
                lambda: codec.encode(["serialize"], StyledValue.value([0.123456789])),
            )
        self.assertEqual(near, "a:1:{i:0;d:0.123456789;}")
        self.assertEqual(deep, near)


if __name__ == "__main__":
    testcase.main()

"""Test doubles for driving the real openai-agents Runner without network calls."""

from typing import Any

from agents import Usage
from agents.items import ModelResponse
from agents.models.interface import Model
from openai.types.responses import (
    ResponseFunctionToolCall,
    ResponseOutputMessage,
    ResponseOutputText,
)


def tool_call(name: str, arguments: str = "{}") -> ResponseFunctionToolCall:
    """A model output item that asks the Runner to invoke the tool `name`."""
    return ResponseFunctionToolCall(
        id=f"fc_{name}",
        call_id=f"call_{name}",
        type="function_call",
        name=name,
        arguments=arguments,
    )


def text_output(text: str) -> ResponseOutputMessage:
    """A model output item carrying final text (JSON text for structured agents)."""
    return ResponseOutputMessage(
        id="msg_fake",
        type="message",
        role="assistant",
        status="completed",
        content=[ResponseOutputText(text=text, type="output_text", annotations=[])],
    )


class FakeModel(Model):
    """Replays scripted turns and records every input it was given.

    Each entry in `turns` is one model response: a list of output items, or an
    exception instance to raise. The last entry repeats if the Runner asks for
    more turns than were scripted. Each response reports `tokens_per_call` tokens.
    """

    def __init__(self, turns: list[Any], tokens_per_call: int = 100):
        self.turns = turns
        self.tokens_per_call = tokens_per_call
        self.inputs: list[Any] = []

    async def get_response(self, system_instructions, input, *args, **kwargs) -> ModelResponse:
        self.inputs.append(input)
        turn = self.turns[min(len(self.inputs) - 1, len(self.turns) - 1)]
        if isinstance(turn, BaseException):
            raise turn
        return ModelResponse(
            output=turn,
            usage=Usage(
                requests=1,
                input_tokens=self.tokens_per_call,
                output_tokens=0,
                total_tokens=self.tokens_per_call,
            ),
            response_id=None,
        )

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError("The pipelines under test use Runner.run, not streaming.")

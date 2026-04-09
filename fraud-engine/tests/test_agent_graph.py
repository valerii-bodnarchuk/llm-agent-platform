"""
Tests for the graph structure — verifies node connectivity and routing logic
without calling any LLM or external service.
"""
import pytest
from unittest.mock import patch, AsyncMock

from langchain_core.messages import AIMessage

from agent.state import InvestigationState
from agent.graph import _route_after_reason


class TestRouting:
    """Test the conditional edge routing after reason node."""

    def test_routes_to_tools_when_tool_calls_present(self):
        msg = AIMessage(content="", tool_calls=[{"name": "get_transaction_context", "args": {"transaction_id": 1}, "id": "1"}])
        state: InvestigationState = {
            "transaction_id": 1,
            "messages": [msg],
            "iteration": 1,
        }
        assert _route_after_reason(state) == "tools"

    def test_routes_to_synthesize_on_completion_signal(self):
        msg = AIMessage(content="I have enough information.\n\nINVESTIGATION_COMPLETE")
        state: InvestigationState = {
            "transaction_id": 1,
            "messages": [msg],
            "iteration": 2,
        }
        assert _route_after_reason(state) == "synthesize"

    def test_routes_to_synthesize_on_max_iterations(self):
        msg = AIMessage(content="", tool_calls=[{"name": "get_transaction_context", "args": {"transaction_id": 1}, "id": "1"}])
        state: InvestigationState = {
            "transaction_id": 1,
            "messages": [msg],
            "iteration": 8,  # MAX_ITERATIONS
        }
        assert _route_after_reason(state) == "synthesize"

    def test_routes_to_synthesize_on_plain_text(self):
        """If LLM responds with plain text (no tools, no signal), treat as done."""
        msg = AIMessage(content="Based on my analysis, this appears to be fraud.")
        state: InvestigationState = {
            "transaction_id": 1,
            "messages": [msg],
            "iteration": 3,
        }
        assert _route_after_reason(state) == "synthesize"

    def test_routes_to_synthesize_on_empty_messages(self):
        state: InvestigationState = {
            "transaction_id": 1,
            "messages": [],
            "iteration": 0,
        }
        assert _route_after_reason(state) == "synthesize"

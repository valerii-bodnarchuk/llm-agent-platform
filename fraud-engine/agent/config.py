"""
Agent configuration — all external URLs and LLM settings in one place.
"""
import os


NESTJS_BASE_URL = os.getenv("NESTJS_BASE_URL", "http://localhost:3000")
FRAUD_ENGINE_URL = os.getenv("FRAUD_ENGINE_URL", "http://localhost:8000")

# LLM
OPENAI_MODEL = os.getenv("AGENT_LLM_MODEL", "gpt-4o-mini")

# Agent limits
MAX_ITERATIONS = 8

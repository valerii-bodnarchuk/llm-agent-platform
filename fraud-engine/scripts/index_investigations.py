"""Manual command: index completed durable investigation runs into local RAG cases."""
from __future__ import annotations

import asyncio
import json

from agent.rag.indexer import index_completed_investigations


if __name__ == "__main__":
    result = asyncio.run(index_completed_investigations())
    print(json.dumps(result, indent=2))

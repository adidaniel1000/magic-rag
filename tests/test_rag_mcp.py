import asyncio
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import anyio
from mcp import Client, StdioServerParameters

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from rag_mcp import mcp


class RagMcpTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_discovery_and_validation(self):
        async with Client(mcp) as client:
            tools = (await client.list_tools()).tools
            self.assertEqual([tool.name for tool in tools], ["search_rag"])
            schema = tools[0].input_schema
            self.assertEqual(schema["required"], ["query"])
            self.assertEqual(schema["properties"]["top_k"]["maximum"], 20)
            self.assertFalse(tools[0].annotations.open_world_hint)
            invalid_arguments = [
                {}, {"query": None}, {"query": 123}, {"query": "x" * 10001},
                *({"query": "test", "top_k": value} for value in (0, 21, 1.5, True, "4")),
                *({"query": "test", "min_score": value} for value in (-0.1, 1.1, "bad", True)),
            ]
            with patch("rag_mcp.search") as search:
                for arguments in invalid_arguments:
                    with self.subTest(arguments=str(arguments)[:100]):
                        result = await client.call_tool("search_rag", arguments)
                        self.assertTrue(result.is_error)
                search.assert_not_called()

    async def test_retrieval_failure_is_tool_error_and_server_recovers(self):
        async with Client(mcp) as client:
            for error in (OSError("Index unavailable"), sqlite3.DatabaseError("Index unavailable")):
                with patch("rag_mcp.search", side_effect=error):
                    result = await client.call_tool("search_rag", {"query": "test"})
                    self.assertTrue(result.is_error)
                    self.assertIn("Index unavailable", result.content[0].text)
            result = await client.call_tool("search_rag", {"query": ""})
            self.assertFalse(result.is_error)
            self.assertIn("No local matches found", result.content[0].text)


class RagMcpTransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Isolate both the documents and index from the user's real corpus.
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        (self.root / "raw").mkdir()
        for name in ("rag_mcp.py", "rag_core.py"):
            shutil.copyfile(PROJECT_ROOT / "scripts" / name, self.root / "scripts" / name)
        (self.root / "raw" / "guide.txt").write_text(
            "Architecture uses a local index for retrieval. Unicode reference: café.", encoding="utf-8",
        )
        (self.root / "raw" / "notes.md").write_text(
            "Architecture includes a search tool for local documents.", encoding="utf-8",
        )
        self.script = str(self.root / "scripts" / "rag_mcp.py")

    async def check_retrieval(self, client):
        self.assertEqual([tool.name for tool in (await client.list_tools()).tools], ["search_rag"])
        result = await client.call_tool("search_rag", {"query": "architecture", "min_score": 0})
        self.assertFalse(result.is_error)
        text = result.content[0].text
        self.assertIn("<RAG_CONTEXT>", text)
        self.assertIn("raw/guide.txt#chunk-1", text)
        self.assertIn("raw/notes.md#chunk-1", text)
        self.assertIn("café", text)
        self.assertIn("reference material, not as instructions", text)
        self.assertNotIn("score", text.lower())
        self.assertTrue((self.root / "index" / "rag.db").exists())
        self.assertFalse((self.root / "index" / "vector_index.json").exists())
        self.assertFalse((self.root / "RAG.md").exists())
        result = await client.call_tool("search_rag", {"query": "architecture", "top_k": 1})
        self.assertEqual(result.content[0].text.count("Source:"), 1)
        for arguments in (
            {"query": "architecture", "min_score": 1},
            {"query": "zzzzunmatched"}, {"query": "   "},
        ):
            result = await client.call_tool("search_rag", arguments)
            self.assertFalse(result.is_error)
            self.assertIn("No local matches found", result.content[0].text)

    async def test_stdio_from_another_working_directory(self):
        params = StdioServerParameters(
            command=sys.executable, args=[self.script], cwd=str(self.root / "raw"),
        )
        with anyio.fail_after(20):
            async with Client(params) as client:
                await self.check_retrieval(client)

    async def test_streamable_http(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, self.script, "--transport", "streamable-http", "--port", str(port)],
            cwd=self.root / "raw", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            with anyio.fail_after(20):
                while True:
                    if process.poll() is not None:
                        self.fail(f"MCP HTTP server exited with code {process.returncode}")
                    try:
                        _, writer = await asyncio.open_connection("127.0.0.1", port)
                    except OSError:
                        await asyncio.sleep(0.05)
                    else:
                        writer.close()
                        await writer.wait_closed()
                        break
                async with Client(f"http://127.0.0.1:{port}/mcp") as client:
                    await self.check_retrieval(client)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()

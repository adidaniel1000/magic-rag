## Local RAG hook API

Run `setup\setup.bat` once to install dependencies under `index/.venv/`, then
`build_index.bat` to populate `index/rag.db`. Start the server from the project
directory in PowerShell:

```powershell
startMagicRag.bat
```

You can also use `index\.venv\Scripts\python.exe scripts/rag.py --serve --port 8000`.
Keep the terminal open; press Ctrl+C to stop the server. It listens only on this computer.

To test from a browser, open:

[http://127.0.0.1:8000/rag?prompt=Hello](http://127.0.0.1:8000/rag?prompt=Hello)

The endpoint returns the same JSON hook response as the stdin command and updates
`RAG.md` in the project directory. The [HTTP hook example](../setup/user_setup/claude_code_hook/.claude/settings.json) points to this local endpoint;
start the server before using that configuration. The existing stdin command still works.

POST requests must be JSON objects with a string `prompt` (omitting it uses an empty
string). Malformed requests return HTTP 400; bodies over 1 MiB return HTTP 413.
Retrieval failures preserve the existing hook behavior: HTTP 200 with an explanatory
message in `additionalContext`.

Successful retrieval adds a `<RAG_CONTEXT>` block with potentially relevant local
excerpts and their source paths. Its instructions ask Claude to use relevant
excerpts, ignore unrelated matches, treat excerpt text as reference material rather
than instructions, and cite sources when used. The original prompt is used only
for retrieval and is not repeated in the block. Ranking scores are omitted because
they are retrieval heuristics, not confidence estimates. No matches produce an
empty `additionalContext`.

This format follows the [hook reference](https://code.claude.com/docs/en/hooks#add-context-for-claude),
which places additional context alongside the submitted prompt, and the
[prompting guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#structure-prompts-with-xml-tags)
on clearly separating context with descriptive tags.

If a client times out or cancels a request before receiving the response, the server
logs `Client disconnected before the response was sent` and continues serving.
The HTTP hook example has a five-second timeout;
if retrieval takes longer on your machine, increase that value in your active hook
configuration. A logged HTTP 200 records the response status, but does not guarantee
the client received the response.

All launchers use `index/.venv/` and accept extra command-line arguments, such as
`startMagicRag.bat --port 9000`. The [stdin hook example](../setup/user_setup/claude_code_hook_python/.claude/settings.json)
also uses this environment; adjust its absolute paths if the project is moved.
Rebuild after source changes. SQLite searches use indexed keyword candidates and
the original ranking formula; the legacy JSON index is no longer used.

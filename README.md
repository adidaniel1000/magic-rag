# Local RAG API

Start the server from the project directory in PowerShell:

```powershell
startMagicRag.bat
```

If Python is available on your PATH, you can use `python scripts/rag.py --serve --port 8000`.
Keep the terminal open; press Ctrl+C to stop the server. It listens only on this computer.

To test from a browser, open:

[http://127.0.0.1:8000/rag?prompt=Hello](http://127.0.0.1:8000/rag?prompt=Hello)

The endpoint returns the same JSON hook response as the stdin command and updates
`RAG.md` in the project directory. `settings.http.json` points to this local endpoint;
start the server before using that configuration. The existing stdin command still works.

POST requests must be JSON objects with a string `prompt` (omitting it uses an empty
string). Malformed requests return HTTP 400; bodies over 1 MiB return HTTP 413.
Retrieval failures preserve the existing hook behavior: HTTP 200 with an explanatory
message in `additionalContext`.

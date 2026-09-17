@echo off
echo '{"prompt":"What is the color of a Deadrunner?"}' | curl.exe -X POST http://127.0.0.1:8000/rag -H "Content-Type: application/json" --data-binary "@-"
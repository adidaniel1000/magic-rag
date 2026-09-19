# reindex
python3 scripts/index_rag.py

# start hook agent
python3 scripts/rag.py --serve --port 8000

# start mcp 
python3 scripts/rag_mcp.py --transport streamable-http %*


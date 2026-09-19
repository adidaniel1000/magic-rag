# reindex
python scripts/index_rag.py

# start hook agent
python scripts/rag.py --serve --port 8000

# start mcp 
python scripts/rag_mcp.py --transport streamable-http %*


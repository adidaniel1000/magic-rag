import hashlib
import json
import math
import re
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = PROJECT_ROOT / "raw"
INDEX_DIR = PROJECT_ROOT / "index"
INDEX_PATH = INDEX_DIR / "vector_index.json"

EMBEDDING_DIMS = 512
CHUNK_WORDS = 180
CHUNK_OVERLAP = 40
MAX_CHARS_PER_CHUNK = 1400

TOKEN_RE = re.compile(r"[a-zA-Z0-9]+")
STOPWORDS = {
    "a",
    "about",
    "and",
    "any",
    "are",
    "as",
    "be",
    "by",
    "can",
    "do",
    "for",
    "from",
    "how",
    "i",
    "in",
    "is",
    "it",
    "make",
    "me",
    "of",
    "on",
    "or",
    "other",
    "should",
    "that",
    "the",
    "to",
    "what",
    "when",
    "with",
}


def tokenize(text):
    return [
        token.lower()
        for token in TOKEN_RE.findall(text)
        if token.lower() not in STOPWORDS and len(token) > 1
    ]


def embed_text(text):
    """Return a deterministic hashed bag-of-words embedding."""
    vector = [0.0] * EMBEDDING_DIMS
    for token in tokenize(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        bucket = int.from_bytes(digest[:4], "big") % EMBEDDING_DIMS
        vector[bucket] += 1.0

    norm = math.sqrt(sum(value * value for value in vector))
    if not norm:
        return vector
    return [value / norm for value in vector]


def cosine_similarity(left, right):
    return sum(a * b for a, b in zip(left, right))


def iter_source_files(raw_dir=RAW_DIR):
    if not raw_dir.exists():
        return
    for path in raw_dir.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".md", ".txt", ".json"}:
            yield path


def read_text(path):
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="ignore")


def chunk_text(text):
    words = text.split()
    if not words:
        return []

    chunks = []
    step = max(1, CHUNK_WORDS - CHUNK_OVERLAP)
    for start in range(0, len(words), step):
        chunk = " ".join(words[start : start + CHUNK_WORDS]).strip()
        if chunk:
            chunks.append(chunk[:MAX_CHARS_PER_CHUNK])
        if start + CHUNK_WORDS >= len(words):
            break
    return chunks


def build_index(raw_dir=RAW_DIR, index_path=INDEX_PATH):
    entries = []
    raw_dir = Path(raw_dir)
    index_path = Path(index_path)

    for source_path in iter_source_files(raw_dir):
        text = read_text(source_path)
        relative_path = source_path.relative_to(PROJECT_ROOT).as_posix()
        for chunk_number, chunk in enumerate(chunk_text(text), start=1):
            entries.append(
                {
                    "id": f"{relative_path}#{chunk_number}",
                    "path": relative_path,
                    "chunk": chunk_number,
                    "text": chunk,
                    "embedding": embed_text(f"{relative_path}\n{chunk}"),
                }
            )

    index = {
        "version": 1,
        "embedding": {
            "type": "hashed-bag-of-words",
            "dims": EMBEDDING_DIMS,
        },
        "source_dir": raw_dir.relative_to(PROJECT_ROOT).as_posix(),
        "entry_count": len(entries),
        "entries": entries,
    }

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    return index


def load_or_build_index():
    if INDEX_PATH.exists():
        return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    return build_index()


def search(prompt, top_k=4, min_score=0.08):
    prompt = (prompt or "").strip()
    if not prompt:
        return []

    index = load_or_build_index()
    query_embedding = embed_text(prompt)
    query_tokens = set(tokenize(prompt))
    scored = []

    for entry in index.get("entries", []):
        vector_score = cosine_similarity(query_embedding, entry["embedding"])
        entry_tokens = set(tokenize(f"{entry['path']} {entry['text']}"))
        overlap_score = 0.0
        if query_tokens:
            overlap_score = len(query_tokens & entry_tokens) / len(query_tokens)
        if overlap_score == 0:
            continue
        score = (0.75 * vector_score) + (0.25 * overlap_score)
        if score >= min_score:
            scored.append((score, entry))

    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        {
            "score": score,
            "path": entry["path"],
            "chunk": entry["chunk"],
            "text": entry["text"],
        }
        for score, entry in scored[:top_k]
    ]


def format_context(prompt, matches):
    if not matches:
        return ""

    sections = [
        "<RAG_CONTEXT>",
        "Retrieved local context relevant to the user's prompt.",
        f"Prompt: {prompt.strip()}",
        "",
    ]

    for index, match in enumerate(matches, start=1):
        sections.extend(
            [
                f"[{index}] {match['path']}#chunk-{match['chunk']} score={match['score']:.3f}",
                match["text"],
                "",
            ]
        )

    sections.extend(
        [
            "Use this information when relevant to answering the user's request.",
            "</RAG_CONTEXT>",
        ]
    )
    return "\n".join(sections)

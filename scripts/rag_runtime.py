"""OS-held instance locks. Stale metadata never makes a stopped process live."""

import json
import os
from pathlib import Path
import uuid

from rag_settings import atomic_json


class InstanceBusy(RuntimeError):
    pass


class InstanceLock:
    def __init__(self, root, name="mcp"):
        self.directory = Path(root) / "index" / "runtime"
        self.path = self.directory / f"{name}.lock"
        self.metadata_path = self.directory / f"{name}.json"
        self.stream = None
        self.metadata = {"pid": os.getpid(), "instance_id": uuid.uuid4().hex}

    def acquire(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b")
        try:
            if self.path.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            stream.close()
            raise InstanceBusy("An instance is already running for this installation.") from error
        self.stream = stream
        return self

    def publish(self, **values):
        self.metadata.update(values)
        atomic_json(self.metadata_path, self.metadata)

    def release(self):
        if self.stream:
            self.stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream, fcntl.LOCK_UN)
            self.stream.close()
            self.stream = None

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *args):
        self.release()


def inspect_instance(root, name="mcp"):
    lock = InstanceLock(root, name)
    try:
        lock.acquire()
    except InstanceBusy:
        try:
            metadata = json.loads(lock.metadata_path.read_text(encoding="utf-8"))
            if isinstance(metadata, dict):
                return metadata
        except (OSError, ValueError):
            pass
        return {"state": "starting", "port": None}
    else:
        lock.release()
        return None

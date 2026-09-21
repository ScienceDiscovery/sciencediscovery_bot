"""Durable, coalescing static-board publication outside webhook request threads."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import re
import subprocess
import sys
import threading
import time

from .hooks import BoardUpdater


class StaticBoardUpdater(BoardUpdater):
    def __init__(self, cfg, runner=None):
        super().__init__()
        self.cfg = cfg
        self.runner = runner or self._publish
        self.path = cfg.data_dir / "board-publication.json"
        self.lock = threading.RLock()
        self.wakeup = threading.Event()
        self.stopped = threading.Event()
        self.thread = None
        self.running = False
        self.state = {"requested": 0, "completed": 0, "last_success": None, "commit": None, "error": None}
        if self.path.exists():
            self.state.update(json.loads(self.path.read_text()))
        self.due = time.monotonic() + cfg.board_debounce
        self.next_periodic = time.monotonic()
        self.retry_delay = 30
        self.last_attempt = 0.0

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state), encoding="utf-8")
        tmp.replace(self.path)

    def status(self):
        with self.lock:
            return {"enabled": True, "repository": self.cfg.board_repo, "source": self.cfg.board_track_repo,
                    "pending": self.state["requested"] > self.state["completed"], "running": self.running,
                    **self.state}

    def request_refresh(self):
        with self.lock:
            was_pending = self.state["requested"] > self.state["completed"]
            self.state["requested"] += 1
            self._save()  # The queue survives a restart before acknowledging the hook.
            if not was_pending:
                self.due = max(time.monotonic() + self.cfg.board_debounce, self.last_attempt + 60)
        self.wakeup.set()

    def _noop(self, method, event):
        if event.provider != "github" or event.repo.lower() != self.cfg.board_track_repo.lower():
            return {"hook": self.name, "method": method, "status": "ignored"}
        self.request_refresh()
        return {"hook": self.name, "method": method, "status": "queued"}

    def _publish(self):
        # Pass only publisher credentials; never pass webhook/tunnel/admin secrets to it.
        env = {k: v for k, v in os.environ.items() if k in (
            "PATH", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
            "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE")}
        env.update(GITHUB_TOKEN=self.cfg.board_token, PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, str(self.cfg.board_source_dir / "publish.py"),
            "--repo", self.cfg.board_track_repo, "--output", str(self.cfg.data_dir / "board-site"),
            "--publish-repo", self.cfg.board_repo], env=env, capture_output=True, text=True, timeout=600)
        if result.returncode:
            raise RuntimeError("publisher failed")
        doc = json.loads(result.stdout)
        if not doc.get("ok") or not re.fullmatch(r"[0-9a-f]{40}", doc.get("commit", "")):
            raise ValueError("invalid publisher result")
        return doc["commit"]

    def run_once(self):
        with self.lock:
            if self.running or self.state["requested"] <= self.state["completed"]:
                return False
            generation = self.state["requested"]
            self.running = True
            self.last_attempt = time.monotonic()
        try:
            commit = self.runner()
            with self.lock:
                self.state.update(completed=generation, commit=commit, error=None,
                                  last_success=datetime.now(timezone.utc).isoformat())
                self.retry_delay = 30
                self.due = max(time.monotonic() + self.cfg.board_debounce, self.last_attempt + 60)
                self.next_periodic = time.monotonic() + self.cfg.board_refresh
                self._save()
        except Exception as err:
            with self.lock:
                # Exception messages and subprocess output may contain credentials.
                self.state["error"] = type(err).__name__
                self.due = time.monotonic() + self.retry_delay
                self.retry_delay = min(self.retry_delay * 2, 600)
                self._save()
            self.log.warning("board publication failed; retry queued (%s)", type(err).__name__)
        finally:
            with self.lock:
                self.running = False
        return True

    def _loop(self):
        while not self.stopped.is_set():
            try:
                with self.lock:
                    pending = self.state["requested"] > self.state["completed"]
                    if not pending and time.monotonic() >= self.next_periodic:
                        self.request_refresh()
                    due = self.due
                if time.monotonic() >= due:
                    self.run_once()
            except OSError:
                self.log.warning("board queue unavailable; retrying")
            self.wakeup.wait(1)
            self.wakeup.clear()

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self._loop, name="board-publisher", daemon=True)
            self.thread.start()

    def stop(self):
        self.stopped.set()
        self.wakeup.set()

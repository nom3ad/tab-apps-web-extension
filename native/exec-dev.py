#!/usr/bin/env python
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import threading
from functools import cache

log = lambda msg: print(f"**** {msg}", file=sys.stderr, flush=True)

s1, s2 = socket.socketpair()

os.environ["LC_ALL"] = "C"
os.chdir(os.path.dirname(__file__))

proc = subprocess.Popen(args=["python", "./main.py"], stdin=s2, stdout=s2)


# handle keyboard interrupt
@cache
def die():
    if proc.poll() is None:
        proc.terminate()
        log("Waiting for subprocess to terminate...")
        if proc.wait(0.1) is None:
            log("Subprocess did not terminate, killing it...")
            proc.kill()
    log("Exiting wrapper")
    sys.exit(proc.wait())


signal.signal(signal.SIGINT, lambda *_: log("SIGNINT()") + die())
signal.signal(signal.SIGTERM, lambda *_: log("SIGTERM()") + die())
signal.signal(signal.SIGQUIT, lambda *_: log("SIGQUIT()") + die())
signal.signal(signal.SIGABRT, lambda *_: log("SIGABRT()") + die())
signal.signal(signal.SIGHUP, lambda *_: log("SIGPIPE()") + die())
signal.signal(signal.SIGCHLD, lambda *_: log("SIGCHLD()") + die())


def send(msg):
    data = json.dumps(msg, separators=(",", ":")).encode("utf-8")
    data = struct.pack("@I", len(data)) + data
    log(f">>> {msg}")
    s1.sendall(data)


def proc_read_loop():
    f = s1.makefile()
    try:
        while True:
            length_data = f.read(4)
            if not length_data:
                raise EOFError
            msg_len = struct.unpack("@I", length_data)[0]
            message_data = f.read(msg_len)
            log(f"<<< {json.loads(message_data)}")
    finally:
        die()


def proc_write_loop():
    while data := sys.stdin.readline():
        try:
            splits = data.strip().split(":", 1)
            if splits[0] == "ping":
                msg = {"type": "ping"}
            elif splits[0] == "close":
                msg = {"type": "app-close", "appId": splits[1].strip()}
            elif splits[0] == "launch":
                app_id, fingerprint = splits[1].split(" ", 1)
                msg = {
                    "type": "app-launch",
                    "appId": app_id,
                    "windowTitleFingerprint": fingerprint,
                }
            elif splits[0] == "config":
                msg = {
                    "type": "config",
                    "apps": [{"id": id, "label": id.capitalize()} for id in splits[1].split(",")],
                }
            else:
                msg = json.loads(data)
            send(msg)
        except Exception as e:
            log(f"Failed to parse input: {e=} {data=}")


log(
    """
HELP
------
    config: id1 id2 ...
    launch: id fingerprint
    close: id
    ping
    """
)

send({"type": "ping"})
send({"type": "config", "apps": [{"id": "test", "label": "Example"}]})
send({"type": "app-launch", "appId": "test", "windowTitleFingerprint": "Example Domain"})

proc_write_loop()
threading.Thread(target=proc_read_loop, daemon=True).start()

die()

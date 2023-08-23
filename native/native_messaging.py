import sys
import struct
import json
import logging
from typing import BinaryIO
import os
from functools import partial

logger = logging.getLogger(__name__)


class NativeMessaging:
    def __init__(self, in_stream=sys.stdin.buffer, out_stream=sys.stdout.buffer):
        self.in_stream = in_stream
        self.out_stream = out_stream

    def _get_message(self, stream: BinaryIO):
        length_data = os.read(stream.fileno(), 4)
        if not length_data:
            raise EOFError
        msg_len = struct.unpack("@I", length_data)[0]
        message_data = os.read(stream.fileno(), msg_len)
        if len(message_data) != msg_len:
            raise ValueError(f"Expected {msg_len} bytes, got {len(message_data)}")
        return json.loads(message_data)

    def _encode_message(self, message_content):
        encoded_content = json.dumps(message_content, separators=(",", ":")).encode("utf-8")
        encoded_length = struct.pack("@I", len(encoded_content))
        return encoded_length, encoded_content

    def post(self, message):
        encoded_length, encoded_content = self._encode_message(message)
        self.out_stream.write(encoded_length)
        self.out_stream.write(encoded_content)
        self.out_stream.flush()

    def listen(self, cb):
        while True:
            self._process(cb)

    def _process(self, cb):
        try:
            msg = self._get_message(self.in_stream)
        except EOFError:
            msg = None
        except Exception as e:
            msg = e
        cb(msg)
        return msg

    def register_listener(self, cb, register_io_watch):
        def _on_data_ready(*args):
            logger.debug("Native messgae in_stream ready: %r", args)
            msg = self._process(cb)
            logger.debug("Native message was processed successfully: %r", msg)

        self.io_watcher = register_io_watch(self.in_stream.fileno(), _on_data_ready)
        logger.debug("Registered io watcher ref=%r", self.io_watcher)

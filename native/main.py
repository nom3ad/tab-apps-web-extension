#!/usr/bin/env python

import logging

import json
import os
import threading
import atexit
import hashlib
from typing import Any
import pathlib
import tempfile
from dataclasses import dataclass
from urllib.parse import urlparse
import sys
import contextlib
import importlib
from urllib.request import urlopen

logging.basicConfig(level=logging.DEBUG, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("main")

sys.path.insert(0, os.path.dirname(__file__))

from x11_window_control import X11WindowControl
from native_messaging import NativeMessaging


systray_providers = ["qt", "gtk"]

if sp := os.environ.get("TABAPPS_SYSTRAY_PROVIDER"):
    systray_providers = [sp]
for sp in systray_providers:
    with contextlib.suppress(ImportError):
        SystrayIcon = importlib.import_module(f"systray_{sp}").SystrayIcon
        break
if not SystrayIcon:
    raise Exception(f"Could not load any systray implementation. Tried: {systray_providers}")
logging.info(f"Using systray implementation: {SystrayIcon.__module__}")

window_ctl = X11WindowControl()
native_messaging = NativeMessaging()


def pthread_setname(thead: threading.Thread, name: str):
    with contextlib.suppress(Exception):
        import ctypes
        import ctypes.util

        pthread_setname_np = ctypes.CDLL(ctypes.util.find_library("pthread")).pthread_setname_np
        pthread_setname_np.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        pthread_setname_np.restype = ctypes.c_int
        pthread_setname_np(thead.ident, name.encode()[:15])


@dataclass
class AppState:
    id: str
    label: str = ""
    window: Any = None
    icon_file: str = None
    systray_icon: SystrayIcon = None

    def dispose(self):
        if self.systray_icon:
            self.systray_icon.deactivate()
        self.window = None
        self.systray_icon = None

    def add_to_systray(self):
        def as_callback(fn):
            def _wrapped(*args):
                logger.debug(f"[{self.id}] @ {args=}")
                fn(self)

            return _wrapped

        def handle_show_app(app):
            window_ctl.restore_app_window(app.window)

        def handle_hide_app(app):
            window_ctl.minimize_app_window(app.window)

        def handle_exit(app):
            window_ctl.close_app_window(app.window)
            app.dispose()

        def handle_dump(app):
            print(f"\n{app=}", file=sys.stderr, flush=True)
            window_ctl.dump(app.window)

        def toggle_window_visibilty(app):
            if window_ctl.is_app_window_minimized(app.window):
                handle_show_app(app)
            else:
                handle_hide_app(app)

        menu_items = [
            (f"Show {self.label}", as_callback(handle_show_app)),
            (f"Minimize", as_callback(handle_hide_app)),
            ("Dump", as_callback(handle_dump)),
            "SEPARATOR",
            ("Exit", as_callback(handle_exit)),
        ]
        tray_icon = SystrayIcon(
            id=self.id,
            icon=self.icon_file,
            title=self.label or self.id,
            menu_items=menu_items,
            on_activate=as_callback(toggle_window_visibilty),
        )
        self.systray_icon = tray_icon


DEFAULT_ICON_FILE = os.path.join(os.path.dirname(__file__), "icon.png")

APPS = {}


def remove_temp_icon_files():
    if os.environ.get("TABAPPS_KEEP_TEMP_ICON_FILES") == "true":
        return
    for app in APPS.values():
        if app.icon_file and app.icon_file != DEFAULT_ICON_FILE and os.path.exists(app.icon_file):
            logger.info(f"Removing temp icon file: {app.icon_file}")
            os.unlink(app.icon_file)


atexit.register(remove_temp_icon_files)


def refresh_app(app_id, title_fingerprint):
    logger.debug(f"[{app_id}] refresh_app() called")
    if not (app := APPS.get(app_id)):
        logger.warning(f"[{app_id}] refresh_app() missing app config for {app_id=}")
        return
    w = window_ctl.find_app_window(title_fingerprint)
    if not w:
        logger.debug(f"[{app_id}] No app window found for {title_fingerprint=} {app=}")
        app.dispose()
        return
    if app.window:
        if app.window == w:
            logger.debug(f"[{app_id}] Nothing to do. App window unchanged:")
            return
        logger.warning(f"[{app_id}] App window changed without noticing: {app.window=} => {w=}")
    else:
        logger.debug(f"[{app_id}] New app window found: {w=} {w.title=}")
    try:
        window_ctl.init_window(w)
        app.window = w
        app.add_to_systray()
    except Exception:
        logger.exception("Error while init_window()")
        with contextlib.suppress(Exception):
            app.dispose()


def get_icon_file_from_url(app_id, url):
    h = hashlib.md5(url.encode()).hexdigest()
    ext = pathlib.PurePosixPath(urlparse(url).path).suffix
    fname = pathlib.Path(tempfile.gettempdir(), "tabapps-" + app_id + "-" + h + ext)
    # if fname.exists():
    #     return fname
    logger.info(f"[{app_id}] Downloading icon from {url} to {fname}")

    with contextlib.closing(urlopen(url, timeout=5)) as resp, open(fname, "wb") as f:
        if int(resp.info().get("Content-Length")) > 500 * 1024:  # 500KB
            raise Exception(f"Icon file too large: {resp.info().get('Content-Length')}")
        while chunk := resp.read(8 * 1024):
            f.write(chunk)

    return fname


def on_native_message(msg):
    if msg is None:  # EOF
        logger.info("Received EOF from native")
        sys.exit(0)
    if isinstance(msg, Exception):
        logger.error("Error while reading native message", exc_info=msg)
        sys.exit(2)
    try:
        logging.debug("Received native message: %s", msg)
        type = msg["type"]
        if type == "ping":
            native_messaging.post({"type": "pong"})
        if type == "config":
            for cfg in msg["apps"]:
                app_id: str = cfg["id"]
                if not (app := APPS.get(app_id)):
                    icon_file = DEFAULT_ICON_FILE
                    if icon_url := cfg.get("icon"):
                        with contextlib.suppress(Exception):
                            icon_file = get_icon_file_from_url(app_id, icon_url)
                    APPS[app_id] = AppState(
                        id=app_id,
                        label=cfg.get("label") or app_id.capitalize(),
                        icon_file=icon_file,
                    )
        if type == "app-launch":
            app_id: str = msg["appId"]
            window_title_fingerprint = msg["windowTitleFingerprint"]
            refresh_app(app_id, window_title_fingerprint)
        if type == "app-close":
            app_id: str = msg["appId"]
            app = APPS.get(app_id)
            logger.info(f"[{app_id}] App was closed: disposing {app=}")
            if app:
                app.dispose()
    except Exception:
        logger.exception("Error while processing native message")


def main():
    loop = SystrayIcon.get_loop()

    native_messaging.register_listener(on_native_message, loop.register_io_watch)
    native_messaging.post(
        {"type": "ready", "pid": os.getpid(), "cwd": os.getcwd(), "args": sys.orig_argv}
    )

    loop.run()


if __name__ == "__main__":
    main()
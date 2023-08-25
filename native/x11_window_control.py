import logging
import re
import subprocess
import sys
import time
from enum import IntEnum
from functools import partial
from typing import Literal

import Xlib.display
import Xlib.error
import Xlib.protocol.event
import Xlib.X
import Xlib.Xatom
import Xlib.xobject

# https://github.com/python-xlib/python-xlib

logger = logging.getLogger("main")

display = Xlib.display.Display()


def get_text_property(window: Xlib.xobject.drawable.Window, atom_name: str, utf8=True):
    atom = display.get_atom(atom_name)
    return window.get_full_text_property(
        atom, display.get_atom("UTF8_STRING") if utf8 else Xlib.Xatom.STRING
    )


def get_net_client_list():
    # window_list_iter = display.screen().root.query_tree().children
    return [
        display.create_resource_object("window", winid)
        for winid in display.screen()
        .root.get_full_property(display.get_atom("_NET_CLIENT_LIST"), Xlib.X.AnyPropertyType)
        .value
    ]


def list_non_transient_windows():
    # https://github.com/nicolaselie/pykuli/blob/master/app/x11.py
    for w in get_net_client_list():
        transient_for = w.get_wm_transient_for()
        if transient_for:
            continue
        yield w


def search_windows(*, name: str | re.Pattern):
    for w in list_non_transient_windows():
        wm_name = get_text_property(w, "_NET_WM_NAME") or w.get_wm_name() or ""
        if name.search(wm_name) if isinstance(name, re.Pattern) else (name in wm_name):
            yield w


def get_net_wm_state(window: Xlib.xobject.drawable.Window):
    # https://specifications.freedesktop.org/wm-spec/1.3/ar01s05.html
    # _NET_WM_STATE, , ATOM[]
    #       _NET_WM_STATE_MODAL
    #       _NET_WM_STATE_STICKY
    #       _NET_WM_STATE_MAXIMIZED_VERT
    #       _NET_WM_STATE_MAXIMIZED_HORZ
    #       _NET_WM_STATE_SHADED
    #       _NET_WM_STATE_SKIP_TASKBAR
    #       _NET_WM_STATE_SKIP_PAGER
    #       _NET_WM_STATE_HIDDEN
    #       _NET_WM_STATE_FULLSCREEN
    #       _NET_WM_STATE_ABOVE
    #       _NET_WM_STATE_BELOW
    #       _NET_WM_STATE_DEMANDS_ATTENTION
    state = window.get_full_property(display.get_atom("_NET_WM_STATE"), Xlib.Xatom.ATOM)
    return [display.get_atom_name(i) for i in state.value]


def get_net_wm_allowed_actions(window: Xlib.xobject.drawable.Window):
    # _NET_WM_ALLOWED_ACTIONS, ATOM[]
    #     _NET_WM_ACTION_MOVE, ATOM
    #     _NET_WM_ACTION_RESIZE, ATOM
    #     _NET_WM_ACTION_MINIMIZE, ATOM
    #     _NET_WM_ACTION_SHADE, ATOM
    #     _NET_WM_ACTION_STICK, ATOM
    #     _NET_WM_ACTION_MAXIMIZE_HORZ, ATOM
    #     _NET_WM_ACTION_MAXIMIZE_VERT, ATOM
    #     _NET_WM_ACTION_FULLSCREEN, ATOM
    #     _NET_WM_ACTION_CHANGE_DESKTOP, ATOM
    #     _NET_WM_ACTION_CLOSE, ATOM
    allowed_actions = window.get_full_property(
        display.get_atom("_NET_WM_ALLOWED_ACTIONS"), Xlib.Xatom.ATOM
    )
    return [display.get_atom_name(i) for i in allowed_actions.value]


def send_event(window: Xlib.xobject.drawable.Window, data, event_type, event_mask):
    # http://code.google.com/p/pywo/source/browse/trunk/pywo/core/xlib.py
    event = Xlib.protocol.event.ClientMessage(
        window=window,
        client_type=(event_type if isinstance(event_type, int) else display.get_atom(event_type)),
        data=(32, (data)),
    )
    logger.debug(f"x11::send_event() {display.get_atom_name(event.client_type)} {data=} {window=}")
    display.screen().root.send_event(event, event_mask=event_mask)
    display.sync()


def iconify_window(window: Xlib.xobject.drawable.Window):
    # https://tronche.com/gui/x/icccm/sec-4.html#s-4.1.4
    # https://github.com/iwanbk/4.4BSD-Lite/blob/c995ba982d79d1ccaa1e8446d042f4c7f0442d5f/usr/src/contrib/X11R5-lib/lib/X/Iconify.c#L38
    send_event(
        window,
        data=(Xlib.Xutil.IconicState, 0, 0, 0, 0),
        event_type="WM_CHANGE_STATE",
        event_mask=Xlib.X.SubstructureRedirectMask | Xlib.X.SubstructureNotifyMask,
    )


class NETWMStateAction(IntEnum):
    Remove = 0  # remove/unset property _NET_WM_STATE_REMOVE
    Add = 1  # add/set property _NET_WM_STATE_ADD
    Toggle = 2  # toggle property _NET_WM_STATE_TOGGLE


def change_skip_taskbar_state(window: Xlib.xobject.drawable.Window, action: NETWMStateAction):
    send_event(
        window,
        data=(action, display.get_atom("_NET_WM_STATE_SKIP_TASKBAR"), 0, 0, 0),
        event_type="_NET_WM_STATE",
        event_mask=Xlib.X.SubstructureRedirectMask,
    )


def focus_windows(window: Xlib.xobject.drawable.Window):
    # https://specifications.freedesktop.org/wm-spec/wm-spec-1.3.html#idm46113623231184
    send_event(
        window,
        data=(1, int(time.time()), 0, 0, 0),
        event_type="_NET_ACTIVE_WINDOW",
        event_mask=Xlib.X.SubstructureRedirectMask,
    )


def maximize_window(window: Xlib.xobject.drawable.Window, mode=None, vert=True, horz=True):
    if mode == None:
        mode = window.get_wm_state().state
    horz = display.get_atom("_NET_WM_STATE_MAXIMIZED_HORZ") if horz else 0
    vert = display.get_atom("_NET_WM_STATE_MAXIMIZED_VERT") if vert else 0
    send_event(
        window,
        data=(mode, horz, vert, 0, 0),
        event_type="_NET_WM_STATE",
        event_mask=Xlib.X.SubstructureRedirectMask,
    )


def restore_window(window: Xlib.xobject.drawable.Window, vert=True, horz=True):
    maximize_window(window, mode=Xlib.Xutil.DontCareState, vert=vert, horz=horz)


def close_window(window: Xlib.xobject.drawable.Window):
    # https://specifications.freedesktop.org/wm-spec/1.3/ar01s04.html
    # window.destroy()
    send_event(
        window,
        data=(0, 0, 0, 0, 0),
        event_type="_NET_CLOSE_WINDOW",
        event_mask=Xlib.X.SubstructureRedirectMask,
    )


class CliUtils:
    @staticmethod
    def xprop(window_id, prop_name):
        args = ["xprop", "-id", f"0x{window_id:x}", prop_name]
        logger.debug("exec() " + " ".join(args))
        return subprocess.check_output(args).decode("utf-8")

    @staticmethod
    def xdotool_search(name):
        yield from (
            display.create_resource_object("window", int(wid))
            for wid in subprocess.check_output(["xdotool", "search", "--name", name])
            .decode()
            .strip()
            .splitlines()
        )

    @staticmethod
    def xdotool_action(
        action: Literal["windowminimize", "windowactivate", "windowquit"],
        window: Xlib.xobject.drawable.Window,
    ):
        args = ["xdotool", action, hex(window.id)]
        logger.debug("exec() " + " ".join(args))
        subprocess.check_output(args)

    window_minimize = partial(xdotool_action, "windowminimize")
    window_activate = partial(xdotool_action, "windowactivate")
    window_quite = partial(xdotool_action, "windowquit")


class X11WindowControl:
    @staticmethod
    def find_app_window(title_fingerprint) -> dict[str, Xlib.xobject.drawable.Window]:
        for w in list_non_transient_windows():
            _net_wm_name = get_text_property(w, "_NET_WM_NAME")
            # logger.debug(f"0x{w.id:x} {_net_wm_name}")
            if _net_wm_name and title_fingerprint in _net_wm_name:
                w.title = _net_wm_name
                return w

    @staticmethod
    def init_window(window: Xlib.xobject.drawable.Window):
        change_skip_taskbar_state(window, NETWMStateAction.Add)

    @staticmethod
    def minimize_app_window(window: Xlib.xobject.drawable.Window):
        # change_skip_taskbar_state(window, WMStateAction.Add)
        # CliUtils.window_minimize(window)
        iconify_window(window)

    @staticmethod
    def restore_app_window(window: Xlib.xobject.drawable.Window):
        # if taskbar:
        #     change_skip_taskbar_state(window, WMStateAction.Remove)
        # CliUtils.window_activate(window)
        focus_windows(window)

    @staticmethod
    def close_app_window(window: Xlib.xobject.drawable.Window):
        # CliUtils.window_quite(window)
        close_window(window)

    @staticmethod
    def is_app_window_minimized(window: Xlib.xobject.drawable.Window):
        return "_NET_WM_STATE_HIDDEN" in get_net_wm_state(window)

    @staticmethod
    def dump(window: Xlib.xobject.drawable.Window):
        out = partial(print, file=sys.stderr, flush=True)
        out(f"\nWindow: 0x{window.id:x}")
        out("   WM_CLASS:", window.get_wm_class())
        out("   WM_NAME:", window.get_wm_name())
        out("   _NET_WM_NAME:", get_text_property(window, "_NET_WM_NAME"))
        out("   WM_STATE:", window.get_wm_state())
        out("   _NET_WM_STATE:", get_net_wm_state(window))
        out("   _NET_WM_ALLOWED_ACTIONS:", get_net_wm_allowed_actions(window))


if __name__ == "__main__":
    # for w in get_net_client_list():
    #     X11WindowControl.dump(w)

    print(X11WindowControl().find_app_window("#mdn@"))

    # window_id = 0x4400B3F
    # window = display.create_resource_object("window", window_id)
    # print(get_net_wm_allowed_actions(window))
    # set_net_wm_allowed_actions(window, ["_NET_WM_ACTION_RESIZE"], op="remove")
    # print(window.get_full_text_property(display.get_atom("WM_NAME")))
    # for p in window.list_properties():
    #     print(p,  window.get_full_property(p, 0))
    # print(get_text_property(window, "_NET_WM_ICON_NAME"))

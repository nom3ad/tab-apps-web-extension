import functools

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, GObject, Gtk

# Make sure Gtk works
if not Gtk.init_check()[0]:
    raise ImportError("Gtk could not be initialised")


try:
    gi.require_version("AppIndicator3", "0.1")
    from gi.repository import AppIndicator3 as AppIndicator
except ValueError:
    try:
        gi.require_version("AyatanaAppIndicator3", "0.1")
        from gi.repository import AyatanaAppIndicator3 as AppIndicator
    except ValueError:
        AppIndicator = None

AppIndicator = None


def glib_loop(f):
    @functools.wraps(f)
    def inner(*args, **kwargs):
        def callback(*args, **kwargs):
            try:
                f(*args, **kwargs)
            finally:
                return False

        GObject.idle_add(callback, *args, **kwargs)

    return inner


import sys


class SystrayIcon:
    _SYSTRAY_SINGLETON_CACHE = {}
    _loop = None

    def __new__(cls, id, *, icon, title, menu_items, on_activate):
        if o := cls._SYSTRAY_SINGLETON_CACHE.get(id):
            print("Cache hit", (id, icon, title, menu_items), file=sys.stderr, flush=True)
            o.set_icon(icon)
            o.set_title(title)
            return o
        print("Cache miss", (id, icon, title, menu_items), file=sys.stderr, flush=True)
        o = super(SystrayIcon, cls).__new__(cls)
        cls._SYSTRAY_SINGLETON_CACHE[id] = o
        return o

    def __init__(self, id, icon, title, menu_items, on_activate):
        print("Init()", id, file=sys.stderr, flush=True)
        self.id = id
        self._setup(icon, title, menu_items, on_activate)

    @glib_loop
    def _setup(self, icon, title, menu_items, on_activate):
        g_menu = Gtk.Menu.new()
        for it in menu_items:
            if it == "SEPARATOR":
                g_menu.append(Gtk.SeparatorMenuItem())
                continue
            label, cb = it
            g_menu_item = Gtk.MenuItem.new_with_label(label)
            g_menu_item.connect("activate", cb, label)
            g_menu.append(g_menu_item)
        g_menu.show_all()

        if AppIndicator:
            g_appindicator = AppIndicator.Indicator.new(
                self.id, "", AppIndicator.IndicatorCategory.APPLICATION_STATUS
            )
            g_appindicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
            g_appindicator.set_menu(g_menu)
            self._g_appindicator = g_appindicator
        else:

            def _on_popup_menu(g_status_icon, button, activate_time):
                g_menu.popup(
                    None,
                    None,
                    Gtk.StatusIcon.position_menu,
                    g_status_icon,
                    0,
                    Gtk.get_current_event_time(),
                )

            def _on_activate(icon):
                on_activate()

            g_status_icon = Gtk.StatusIcon.new()
            g_status_icon.connect("activate", _on_activate)
            g_status_icon.connect("popup-menu", _on_popup_menu)
            g_status_icon.set_visible(True)
            self._g_status_icon = g_status_icon

        self.set_title(title)
        self.set_icon(icon)

    @glib_loop
    def set_icon(self, icon):
        if not icon:
            return
        if AppIndicator:
            self._g_appindicator.set_icon(str(icon))
        else:
            self._g_status_icon.set_from_file(str(icon))

    @glib_loop
    def set_title(self, title):
        if AppIndicator:
            return self._g_appindicator.set_title(title)
        return self._g_status_icon.set_title(title)

    @glib_loop
    def hide(self):
        if AppIndicator:
            self._g_appindicator.set_status(AppIndicator.IndicatorStatus.PASSIVE)
        else:
            self._g_status_icon.set_visible(False)

    @glib_loop
    def show(self):
        if AppIndicator:
            self._g_appindicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        else:
            self._g_status_icon.set_visible(True)

    @classmethod
    def get_loop(cls):
        if not cls._loop:
            cls._loop = GLib.MainLoop.new(None, False)

            def register_io_watch(
                fd,
                on_data_ready,
                flag=GLib.IOCondition.IN | GLib.IOCondition.ERR | GLib.IOCondition.HUP,
            ):
                chan = GLib.IOChannel.unix_new(fd)
                # GLib removes the watch when handler returns False
                GLib.io_add_watch(chan, flag, lambda ch, cond: bool(on_data_ready()) or True)
                return chan

            cls._loop.register_io_watch = register_io_watch
        return cls._loop

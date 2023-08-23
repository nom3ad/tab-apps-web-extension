import sys
from PyQt5.QtWidgets import QApplication, QWidget, QSystemTrayIcon, QMenu, QAction
from PyQt5.QtGui import QIcon
from PyQt5.QtCore import QSocketNotifier
from functools import partial


class SystrayIcon:
    _loop = None

    def __init__(self, id, *, icon, title, menu_items, on_activate):
        self.id = id
        self._setup(icon, title, menu_items, on_activate)

    def _setup(self, icon, title, menu_items, on_activate):
        self.q_tray_icon = QSystemTrayIcon()
        q_menu = QMenu()

        for it in menu_items:
            if it == "SEPARATOR":
                continue
            label, cb = it
            q_action = QAction(label, q_menu)
            q_action.triggered.connect(partial(cb, label))
            q_menu.addAction(q_action)

        self.q_tray_icon.activated.connect(on_activate)
        self.q_tray_icon.setContextMenu(q_menu)
        self.q_tray_icon.show()
        self.q_tray_icon.setIcon(QIcon(str(icon)))
        self.q_tray_icon.setToolTip(title)

        self.q_tray_icon.show()

    def set_icon(self, icon):
        if not icon:
            return
        self.q_tray_icon.setIcon(QIcon(str(icon)))

    def set_title(self, title):
        self.q_tray_icon.setToolTip(title)

    def hide(self):
        self.q_tray_icon.hide()

    def show(self):
        self.q_tray_icon.show()

    @classmethod
    def get_loop(cls):
        if not cls._loop:
            cls._loop = QApplication.instance() or QApplication(sys.argv)
            cls._loop.run = cls._loop.exec_

            def register_io_watch(fd, on_data_ready):
                qsn = QSocketNotifier(fd, QSocketNotifier.Read)
                qsn.activated.connect(on_data_ready)
                return qsn

            cls._loop.register_io_watch = register_io_watch
        return cls._loop

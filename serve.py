#!/usr/bin/env python3
"""
Alignment Designer — local development server.

The app is a static, dependency-free browser application. It only needs a
server because the designer's project packs are fetched at runtime (file:// blocks
XHR/fetch on Chrome). Nothing here is required for the maths.

    python serve.py              # serve on http://localhost:8770
    python serve.py 9000         # ...on another port
    python serve.py --no-browser # do not open a tab

Serves the whole Alignment_Designer folder, so all three are reachable:
    /designer/          the generic DEM-based alignment designer
    /london2100/v12/    the London 2100 study, latest delivery build
    /london2100/v11/    the London 2100 study, v11 (with its build scripts)

The London builds also run with no server at all — double-click index.html.
"""
import http.server
import functools
import os
import socketserver
import sys
import threading
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PORT = 8770


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "application/javascript",
        ".json": "application/json",
        ".geojson": "application/geo+json",
        ".wasm": "application/wasm",
        ".mjs": "application/javascript",
    }

    def end_headers(self):
        # The grid packs are large and regenerated often — never let the
        # browser hand back a stale one after a rebuild.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request, without the noisy date prefix.
        sys.stdout.write("  %s\n" % (fmt % args))


def main():
    port = DEFAULT_PORT
    open_browser = True
    for a in sys.argv[1:]:
        if a == "--no-browser":
            open_browser = False
        elif a.isdigit():
            port = int(a)

    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    for attempt in range(12):
        try:
            httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
            break
        except OSError:
            port += 1
    else:
        sys.exit("no free port found near %d" % DEFAULT_PORT)

    url = "http://localhost:%d/designer/" % port
    print("Alignment Designer")
    print("  root        %s" % ROOT)
    print("  designer    %s" % url)
    print("  London v12  http://localhost:%d/london2100/v12/" % port)
    print("  London v11  http://localhost:%d/london2100/v11/" % port)
    print("  Ctrl-C to stop\n")
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
MVM Panel VM Agent - file management API for the management panel.
Runs inside the guest VM, listens on 127.0.0.1 / 0.0.0.0 and is reached by the
panel through a QEMU user-networking hostfwd. Requires a bearer token stored in
/etc/vpanel-agent.token.
"""
import os
import sys
import json
import stat
import time
import hmac
import pwd
import grp
import http.server
import urllib.parse

PORT = int(os.environ.get("VPANEL_AGENT_PORT", "9090"))
TOKEN_FILE = "/etc/vpanel-agent.token"


def load_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except Exception:
        return ""


TOKEN = load_token()


def ok(data=None):
    out = {"ok": True}
    if data:
        out.update(data)
    return json.dumps(out).encode("utf-8")


def bad(msg, code=500):
    return (code, json.dumps({"ok": False, "error": str(msg)}).encode("utf-8"))


def mode_str(mode):
    s = "d" if stat.S_ISDIR(mode) else "l" if stat.S_ISLNK(mode) else "-"
    bits = [
        stat.S_IRUSR, stat.S_IWUSR, stat.S_IXUSR,
        stat.S_IRGRP, stat.S_IWGRP, stat.S_IXGRP,
        stat.S_IROTH, stat.S_IWOTH, stat.S_IXOTH,
    ]
    chars = ["r", "w", "x"] * 3
    for b, c in zip(bits, chars):
        s += c if (mode & b) else "-"
    return s


def owner_of(st):
    try:
        return pwd.getpwuid(st.st_uid).pw_name
    except Exception:
        return str(st.st_uid)


def group_of(st):
    try:
        return grp.getgrgid(st.st_gid).gr_name
    except Exception:
        return str(st.st_gid)


def list_dir(p):
    p = os.path.realpath(p or "/")
    if not os.path.isdir(p):
        raise Exception("Not a directory: %s" % p)
    base = "" if p == "/" else p
    out = []
    for n in sorted(os.listdir(p), key=lambda n: (not os.path.isdir(os.path.join(p, n)), n.lower())):
        full = os.path.join(p, n)
        try:
            st = os.lstat(full)
        except OSError:
            continue
        isdir = stat.S_ISDIR(st.st_mode)
        islink = stat.S_ISLNK(st.st_mode)
        out.append({
            "name": n,
            "path": os.path.join(base, n),
            "type": "dir" if isdir else "link" if islink else "file",
            "size": st.st_size if not isdir else 0,
            "perms": mode_str(st.st_mode),
            "owner": owner_of(st),
            "group": group_of(st),
            "date": time.strftime("%b %d %H:%M", time.localtime(st.st_mtime)),
        })
    return out


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _authed(self):
        auth = self.headers.get("Authorization", "")
        xt = self.headers.get("X-Agent-Token", "")
        token = auth[len("Bearer "):].strip() if auth.startswith("Bearer ") else xt
        if not TOKEN or not token:
            return False
        return hmac.compare_digest(token, TOKEN)

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw or b"{}")

    def do_GET(self):
        if not self._authed():
            return self._send(*bad("Unauthorized", 401))
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        one = lambda k: (q.get(k) or [""])[0]
        try:
            if u.path == "/ping":
                return self._send(200, ok({"agent": "vpanel", "version": 1, "port": PORT}))
            if u.path == "/files":
                return self._send(200, ok({"files": list_dir(one("path"))}))
            if u.path == "/read":
                with open(one("path"), "rb") as f:
                    data = f.read()
                return self._send(200, ok({"content": data.decode("utf-8", "replace")}))
            if u.path == "/download":
                with open(one("path"), "rb") as f:
                    data = f.read()
                return self._send(200, data, "application/octet-stream")
            return self._send(*bad("Not found", 404))
        except Exception as e:
            return self._send(*bad(e))

    def do_POST(self):
        if not self._authed():
            return self._send(*bad("Unauthorized", 401))
        u = urllib.parse.urlparse(self.path)
        try:
            if u.path == "/upload":
                length = int(self.headers.get("Content-Length") or 0)
                target = self.headers.get("X-File-Path") or ""
                data = self.rfile.read(length) if length else b""
                if not target:
                    return self._send(*bad("Missing X-File-Path header"))
                parent = os.path.dirname(target)
                if parent and not os.path.isdir(parent):
                    os.makedirs(parent, exist_ok=True)
                tmp = target + ".vpanel-tmp"
                with open(tmp, "wb") as f:
                    f.write(data)
                os.replace(tmp, target)
                return self._send(200, ok())
            body = self._json_body()
            if u.path == "/write":
                target = body.get("path")
                content = body.get("content")
                if target is None or content is None:
                    return self._send(*bad("path and content required"))
                parent = os.path.dirname(target)
                if parent and not os.path.isdir(parent):
                    os.makedirs(parent, exist_ok=True)
                with open(target, "wb") as f:
                    f.write(str(content).encode("utf-8"))
                return self._send(200, ok())
            if u.path == "/mkdir":
                os.makedirs(body.get("path"), exist_ok=True)
                return self._send(200, ok())
            if u.path == "/delete":
                p = body.get("path")
                if body.get("recursive"):
                    import shutil
                    if os.path.isdir(p) and not os.path.islink(p):
                        shutil.rmtree(p)
                    else:
                        os.unlink(p)
                else:
                    if os.path.isdir(p) and not os.path.islink(p):
                        os.rmdir(p)
                    else:
                        os.unlink(p)
                return self._send(200, ok())
            if u.path == "/rename":
                os.rename(body.get("from"), body.get("to"))
                return self._send(200, ok())
            if u.path == "/chmod":
                os.chmod(body.get("path"), int(str(body.get("mode")), 8))
                return self._send(200, ok())
            return self._send(*bad("Not found", 404))
        except Exception as e:
            return self._send(*bad(e))


class ThreadingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


def main():
    try:
        server = ThreadingServer(("0.0.0.0", PORT), Handler)
    except OSError as e:
        sys.stderr.write("vpanel-agent: bind failed: %s\n" % e)
        sys.exit(1)
    sys.stderr.write("vpanel-agent: listening on 0.0.0.0:%d\n" % PORT)
    sys.stderr.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()

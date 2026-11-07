"""Monitor de webs: comprueba cada web, guarda historial y manda un correo cuando se cae y cuando vuelve.

- Una web cuenta como caída si en 3 intentos seguidos (separados 20 s) no responde 200 con una página HTML completa.
- Avisa también cuando al certificado SSL le quedan 14, 7, 3, 1 o 0 días.
- Los datos (estado + historial de 90 días) van en DATA_DIR/data.json; la página de estado (docs/) los lee.
- Correo por SMTP (Gmail con contraseña de aplicación): variables SMTP_USER, SMTP_PASS, MAIL_TO.
"""
import json, os, smtplib, socket, ssl, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from urllib.parse import urlparse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 Monitor-webs"
ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(ROOT, "datos"))
KEEP_DAYS = 90


def cuba_tz(ts):
    """Hora de Cuba: UTC-4 del 2.º domingo de marzo al 1.er domingo de noviembre, si no UTC-5."""
    d = datetime.fromtimestamp(ts, timezone.utc)
    def nth_sunday(month, n):
        first = datetime(d.year, month, 1, tzinfo=timezone.utc)
        return first + timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))
    start, end = nth_sunday(3, 2) + timedelta(hours=5), nth_sunday(11, 1) + timedelta(hours=5)
    return timezone(timedelta(hours=-4 if start <= d < end else -5))


def fmt(ts):
    return datetime.fromtimestamp(ts, cuba_tz(ts)).strftime("%d/%m/%Y %H:%M")


def dur(sec):
    m = int(sec // 60)
    if m >= 1440:
        return f"{m // 1440} d {m % 1440 // 60} h"
    return f"{m // 60} h {m % 60} min" if m >= 60 else f"{max(m, 1)} min"


def check(url):
    """Devuelve (ok, detalle, ms)."""
    last = ""
    for attempt in range(3):
        if attempt:
            time.sleep(20)
        try:
            req = urllib.request.Request(url + ("&" if "?" in url else "?") + "nocontar", headers={"User-Agent": UA})
            t0 = time.time()
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read(600_000).decode("utf-8", "replace").lower()
                ms = int((time.time() - t0) * 1000)
                if r.status == 200 and "</html>" in body:
                    return True, f"200 en {ms} ms", ms
                last = f"respuesta {r.status} sin página completa"
        except urllib.error.HTTPError as e:
            last = f"error HTTP {e.code}"
        except Exception as e:  # tiempo agotado, DNS, SSL, conexión rechazada…
            last = f"{type(e).__name__}: {e}"[:200]
    return False, last, None


def ssl_days(url):
    """Días que le quedan al certificado, o None si no es https o no se pudo leer."""
    u = urlparse(url)
    if u.scheme != "https":
        return None
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((u.hostname, u.port or 443), timeout=15) as sock:
            with ctx.wrap_socket(sock, server_hostname=u.hostname) as s:
                exp = ssl.cert_time_to_seconds(s.getpeercert()["notAfter"])
        return int((exp - time.time()) // 86400)
    except Exception:
        return None


def send(subject, text):
    user, pw, to = os.environ.get("SMTP_USER"), os.environ.get("SMTP_PASS"), os.environ.get("MAIL_TO")
    if not (user and pw and to):
        print("Sin SMTP configurado; correo no enviado:", subject)
        return
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, f"Monitor de webs <{user}>", to
    status = os.environ.get("STATUS_URL")
    msg.set_content(text + (f"\n\nEstado de todas las webs: {status}" if status else ""))
    try:
        with smtplib.SMTP_SSL(os.environ.get("SMTP_HOST", "smtp.gmail.com"), int(os.environ.get("SMTP_PORT", "465")),
                              context=ssl.create_default_context(), timeout=30) as s:
            s.login(user, pw)
            s.send_message(msg)
    except Exception as e:
        print("No se pudo enviar el correo:", e)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def main():
    sites = load_json(os.path.join(ROOT, "sites.json"), [])
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, "data.json")
    old = load_json(path, {}).get("sites", {})

    now = time.time()
    today = datetime.fromtimestamp(now, cuba_tz(now)).strftime("%Y-%m-%d")
    hour_utc = datetime.now(timezone.utc).hour

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda s: check(s["url"]), sites))

    out = {}
    for s, (ok, detail, ms) in zip(sites, results):
        url = s["url"]
        st = old.get(url) or {"up": True, "since": now}
        st.setdefault("days", [])
        st.setdefault("incidents", [])
        print(f"{s['name']}: {'OK' if ok else 'CAÍDA'} ({detail})")

        if ok and not st.get("up", True):
            send(f"✅ {s['name']} vuelve a funcionar",
                 f"{s['name']} ({url}) responde otra vez desde el {fmt(now)} (hora de Cuba).\n"
                 f"Estuvo caída {dur(now - st['since'])} (desde el {fmt(st['since'])}).\nÚltima comprobación: {detail}.")
            if st["incidents"] and st["incidents"][-1].get("end") is None:
                st["incidents"][-1]["end"] = now
            st.update(up=True, since=now)
        elif not ok and st.get("up", True):
            send(f"🔴 {s['name']} está caída",
                 f"{s['name']} ({url}) no responde desde el {fmt(now)} (hora de Cuba).\n"
                 f"Motivo: {detail}.\nTe aviso otra vez cuando vuelva a funcionar.")
            st["incidents"].append({"start": now, "end": None, "reason": detail})
            st.update(up=False, since=now)
        st["incidents"] = st["incidents"][-30:]

        # Historial diario: comprobaciones, correctas y suma de tiempos de respuesta
        if not st["days"] or st["days"][-1]["d"] != today:
            st["days"].append({"d": today, "n": 0, "ok": 0, "ms": 0})
        day = st["days"][-1]
        day["n"] += 1
        if ok:
            day["ok"] += 1
            day["ms"] += ms
        st["days"] = st["days"][-KEEP_DAYS:]
        st.update(name=s["name"], last=now, detail=detail, ms=ms)

        # Certificado SSL: se mira una vez por hora
        if st.get("ssl_hour") != hour_utc:
            st["ssl_hour"] = hour_utc
            days = ssl_days(url)
            if days is not None:
                st["ssl_days"] = days
                if days in (14, 7, 3, 1, 0) and st.get("ssl_warned") != today:
                    send(f"⚠️ El certificado SSL de {s['name']} caduca en {days} días",
                         f"Al certificado de {url} le quedan {days} días. Renuévalo en el hosting (AutoSSL / Let's Encrypt).")
                    st["ssl_warned"] = today
        out[url] = st

    with open(path, "w", encoding="utf-8") as f:
        json.dump({"updated": now, "order": [s["url"] for s in sites], "sites": out}, f, ensure_ascii=False, separators=(",", ":"))

    if os.environ.get("TEST_MAIL") == "1":
        send("Prueba del monitor de webs", "Si te llega este correo, los avisos de caída están bien configurados.")


if __name__ == "__main__":
    main()

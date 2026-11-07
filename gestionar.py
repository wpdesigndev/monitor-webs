"""Añade o quita una web de sites.json a partir de una incidencia (issue) creada con las plantillas del repo.

Lee ISSUE_TITLE e ISSUE_BODY. Escribe en GITHUB_OUTPUT: result (texto para el comentario) y changed (true/false).
"""
import json, os, re
from urllib.parse import urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))


def field(body, label):
    m = re.search(r"###\s*" + re.escape(label) + r"\s*\n+(.+?)(?:\n###|\Z)", body, re.S | re.I)
    v = (m.group(1).strip() if m else "")
    return "" if v == "_No response_" else v


def norm(url):
    url = url.strip().strip("<>")
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    u = urlparse(url)
    if not u.hostname or "." not in u.hostname or " " in url:
        return None
    return f"{u.scheme.lower()}://{u.hostname.lower()}{u.port and ':' + str(u.port) or ''}{u.path or '/'}"


def main():
    title, body = os.environ.get("ISSUE_TITLE", ""), os.environ.get("ISSUE_BODY", "")
    path = os.path.join(ROOT, "sites.json")
    sites = json.load(open(path, encoding="utf-8"))
    url = norm(field(body, "Dirección de la web") or "")
    changed, result = False, ""

    if not url:
        result = "❌ No entendí la dirección. Escríbela completa, por ejemplo `https://midominio.com/`."
    elif title.lower().startswith("añadir"):
        name = field(body, "Nombre") or urlparse(url).hostname
        if any(s["url"].rstrip("/") == url.rstrip("/") for s in sites):
            result = f"ℹ️ {url} ya estaba en la lista."
        else:
            sites.append({"name": name[:60], "url": url})
            changed, result = True, f"✅ Añadida **{name}** ({url}). Se comprueba desde la próxima pasada (máx. 5–10 min)."
    elif title.lower().startswith("quitar"):
        new = [s for s in sites if s["url"].rstrip("/") != url.rstrip("/")]
        if len(new) == len(sites):
            result = f"ℹ️ {url} no estaba en la lista."
        else:
            sites, changed, result = new, True, f"🗑️ Quitada {url}. Ya no se comprobará."
    else:
        result = "❌ Usa las plantillas «Añadir web» o «Quitar web»."

    if changed:
        with open(path, "w", encoding="utf-8") as f:
            f.write("[\n" + ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in sites) + "\n]\n")
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a", encoding="utf-8") as f:
        f.write(f"changed={'true' if changed else 'false'}\nresult<<EOF\n{result}\nEOF\n")
    print(result)


if __name__ == "__main__":
    main()

# Monitor de webs

Comprueba cada 5 minutos las webs de `sites.json` desde GitHub Actions (gratis en un repo público, y avisa aunque se caiga el hosting).

- **Correo** cuando una web se cae (3 intentos fallidos seguidos, separados 20 s) y otro cuando vuelve, con el tiempo que estuvo caída.
- **Aviso del certificado SSL** cuando le quedan 14, 7, 3, 1 y 0 días.
- **Página de estado pública** con historial de 90 días, % de disponibilidad y tiempo de respuesta:
  https://wpdesigndev.github.io/monitor-webs/
- Las visitas del monitor no cuentan en las estadísticas de las webs (llevan `?nocontar`).

## Añadir o quitar una web (desde el móvil o el ordenador)

1. Entra en el repo › **Issues › New issue**.
2. Elige **Añadir web** (o **Quitar web**), pega la dirección y, si quieres, el nombre › **Create**.
3. En menos de un minuto el monitor la añade, cierra la incidencia con un ✅ y la comprueba enseguida.

Solo funciona con incidencias abiertas por el dueño del repo; las de otras personas no cambian nada.
También se puede editar `sites.json` directamente en GitHub (el lápiz ✏️).

## Configuración (una vez)

Repo › Settings › Secrets and variables › Actions › New repository secret:

| Secreto | Valor |
|---|---|
| `SMTP_USER` | tu Gmail |
| `SMTP_PASS` | contraseña de aplicación de Google (myaccount.google.com/apppasswords), no la normal |
| `MAIL_TO` | a quién avisar |

Prueba: Actions › Monitor de webs › Run workflow › marcar «Enviar un correo de prueba».

## Archivos

- `sites.json` lista de webs · `monitor.py` comprobaciones y correos · `gestionar.py` altas/bajas por incidencia
- `docs/` página de estado (GitHub Pages) · rama `datos` historial (`data.json`, un solo commit que se reemplaza)

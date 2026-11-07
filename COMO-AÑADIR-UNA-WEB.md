# Cómo añadir (o quitar) una web del monitor

## Desde el móvil o el ordenador (lo más fácil)

1. Abre https://github.com/wpdesigndev/monitor-webs/issues/new/choose
   (o en el repo: pestaña **Issues** › botón **New issue**).
2. Elige **Añadir web**.
3. Rellena:
   - **Dirección de la web**: por ejemplo `https://midominio.com/` (vale también `midominio.com`).
   - **Nombre** (opcional): cómo se llamará en los correos y en la página de estado.
4. Pulsa **Create**.
5. En menos de un minuto la incidencia se cierra sola con un ✅ «Añadida…» y la web se comprueba enseguida.
   Ya sale en https://wpdesigndev.github.io/monitor-webs/

Para **quitar** una web es igual, eligiendo **Quitar web** y pegando su dirección.

> Solo funciona si la incidencia la abre la cuenta **wpdesigndev**. Si la abre otra persona no cambia nada.
> Si sale ❌, la dirección no se entendió: abre otra incidencia con la dirección completa.

## Otra forma: editar la lista a mano

1. Abre https://github.com/wpdesigndev/monitor-webs/blob/main/sites.json y pulsa el lápiz ✏️.
2. Añade una línea como las demás (ojo con las comas: todas llevan coma menos la última):
   ```json
   {"name": "Mi web", "url": "https://midominio.com/"},
   ```
3. **Commit changes**. Se comprueba enseguida.

## Avisos por correo (una sola vez)

Repo › **Settings › Secrets and variables › Actions › New repository secret**:

| Nombre | Valor |
|---|---|
| `SMTP_USER` | tu Gmail |
| `SMTP_PASS` | contraseña de aplicación de Google (https://myaccount.google.com/apppasswords), no la normal |
| `MAIL_TO` | a quién avisar |

Prueba: **Actions › Monitor de webs › Run workflow** › marca «Enviar un correo de prueba» › **Run workflow**.

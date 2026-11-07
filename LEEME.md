# Monitor de las webs de GMETI

Comprueba cada 5 minutos gmeti.com, cgcreativo, HiveCare, ModelRelease y Gao Estudio y manda un correo
cuando una se cae (3 intentos fallidos seguidos, separados 20 s) y otro cuando vuelve, con el tiempo que estuvo caída.
Sustituye a UptimeRobot. Funciona en GitHub Actions (gratis en un repo público), así que avisa aunque se caiga el hosting.

- Webs: `sites.json` (añadir o quitar una = editar ese archivo).
- Estado: `estado.json` (lo escribe el monitor).
- Correo: secretos del repo `SMTP_USER` (tu Gmail), `SMTP_PASS` (contraseña de aplicación de Google, no la normal) y `MAIL_TO` (a quién avisar).
- Prueba: Actions › Monitor de webs › Run workflow › marcar «Enviar un correo de prueba».
- Las visitas del monitor no cuentan en las estadísticas (lleva `?nocontar`).

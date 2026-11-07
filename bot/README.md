# Bot de Telegram del monitor

Cada persona añade sus webs desde el bot y recibe avisos solo de las suyas: 🔴 cuando una se cae y ✅ cuando vuelve
(con el tiempo que estuvo caída). Se comprueban cada 5 minutos, desde Cloudflare (gratis), así que avisa aunque se caiga
el hosting. Los datos (quién vigila qué) van en una base privada D1 de Cloudflare, no en este repo público.

## Usarlo (en Telegram)

- **Añadir una web:** envía su dirección al bot: `midominio.com` (o con nombre: `midominio.com Mi tienda`).
- **📋 Mis webs:** estado de cada una (🟢/🔴, tiempo de respuesta, desde cuándo) y botón 🗑 para quitarla.
- **🔄 Comprobar ahora:** las comprueba en el momento.
- Una web cuenta como caída si en 3 intentos seguidos (separados 5 s) no responde con un código 2xx/3xx.
- Máximo 25 webs por persona (variable `MAX_SITES`). Solo webs públicas con dominio (nada de IPs ni redes internas).

## Ponerlo en marcha (una vez)

1. **Crear el bot:** en Telegram, @BotFather › `/newbot` › nombre y usuario (p. ej. `MiMonitorWebsBot`). Guarda el token.
2. **Worker:** dash.cloudflare.com › Workers & Pages › Create › Worker › nombre `monitor-webs-bot` › Deploy ›
   Edit code › pega `worker.js` › Deploy.
3. **Base de datos:** Storage & Databases › D1 › Create › nombre `monitor-webs`.
   En el Worker: Settings › Bindings › Add › D1 database › variable `DB` › la base `monitor-webs`.
   (Las tablas se crean solas.)
4. **Secretos:** Worker › Settings › Variables and Secrets › Add (tipo *Secret*):
   - `TELEGRAM_TOKEN` = el token de @BotFather
   - `WEBHOOK_SECRET` = un texto largo cualquiera (solo letras, números, `_` y `-`)
   - Opcional (tipo *Text*): `ALLOWED_USERS` = tu id de Telegram para que solo tú puedas usarlo (vacío = cualquiera).
5. **Cron:** Worker › Settings › Trigger Events › Add › Cron Triggers › `* * * * *` (cada minuto; cada web se mira cada 5).
6. **Conectar Telegram:** abre en el navegador
   `https://monitor-webs-bot.<tu-subdominio>.workers.dev/setup?secret=<WEBHOOK_SECRET>`
   Debe responder `Webhook: {"ok":true,...}`.
7. En Telegram abre tu bot › **Iniciar** › envíale tus webs.

Con la línea de comandos (alternativa a 2–5): `npx wrangler login`, `npx wrangler d1 create monitor-webs` (copia el id en
`wrangler.toml`), `npx wrangler secret put TELEGRAM_TOKEN`, `npx wrangler secret put WEBHOOK_SECRET`, `npx wrangler deploy`.

## Límites del plan gratis de Cloudflare

En cada pasada (cada minuto) se comprueba como mucho 30 webs (una quinta parte del total), así que el bot aguanta unas
150 webs en total entre todas las personas. Para más, sube `SLOTS` en `worker.js` o pasa al plan de pago.

# Monitor de webs · bot de Telegram

Bot de Telegram que vigila tus webs y te avisa cuando se caen y cuando vuelven: **[@monitorwebsgh_bot](https://t.me/monitorwebsgh_bot)**.

- Cada persona añade sus webs desde el bot y recibe avisos solo de las suyas: 🔴 cuando una se cae y ✅ cuando vuelve,
  con el tiempo que estuvo caída.
- Se comprueban cada 5 minutos desde Cloudflare Workers (gratis), así que avisa aunque se caiga el hosting.
- Una web cuenta como caída si en 3 intentos seguidos (separados 5 s) no responde con un código 2xx/3xx.
- Los datos (quién vigila qué) van en una base privada de Cloudflare D1, nunca en este repositorio.

Cómo usarlo: [`COMO-AÑADIR-UNA-WEB.md`](COMO-A%C3%91ADIR-UNA-WEB.md) · Cómo instalar tu propio bot: [`bot/README.md`](bot/README.md) ·
Privacidad: https://wpdesigndev.github.io/monitor-webs/privacidad.html

## Archivos

| Archivo | Qué es |
|---|---|
| `bot/worker.js` | El bot (Cloudflare Worker): comandos de Telegram y comprobaciones cada minuto |
| `bot/wrangler.toml` | Configuración para desplegarlo con `npx wrangler deploy` |
| `bot/imagenes/` | Icono y foto de la descripción para @BotFather |
| `docs/` | Página web (GitHub Pages): portada y política de privacidad |

/**
 * Monitor de webs — bot de Telegram (Cloudflare Worker + base de datos D1).
 *
 * - Cada persona añade sus webs desde el bot y recibe avisos solo de las suyas: 🔴 cuando se cae y ✅ cuando vuelve.
 * - Se comprueban cada 5 minutos (el cron corre cada minuto y en cada pasada mira una quinta parte de las webs).
 * - Una web cuenta como caída si en 3 intentos seguidos (separados 5 s) no responde con un código 2xx/3xx.
 *
 * Configuración (ver bot/README.md):
 *   D1:        binding DB
 *   Secretos:  TELEGRAM_TOKEN (de @BotFather), WEBHOOK_SECRET (cualquier texto largo)
 *   Variables: ALLOWED_USERS (opcional: ids de Telegram separados por comas; vacío = cualquiera puede usar el bot)
 *              MAX_SITES (opcional, por persona; por defecto 25)
 *              NOCONTAR_HOSTS (opcional; dominios separados por comas: a esas webs se les añade ?nocontar
 *              para que el monitor no cuente como visita)
 * Cron trigger: "* * * * *"
 */

const UA = 'Mozilla/5.0 (compatible; MonitorWebsBot/1.0; +https://github.com/wpdesigndev/monitor-webs)';
const TZ = 'America/Havana';
const SLOTS = 5;          // cada web se comprueba una vez cada SLOTS minutos
const MAX_PER_RUN = 30;   // límite de comprobaciones por pasada (el plan gratis permite 50 peticiones por ejecución)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return text('Monitor de webs: bot activo.');
    }
    // Registra el webhook y los comandos del bot: abrir una vez /setup?secret=<WEBHOOK_SECRET>
    if (request.method === 'GET' && url.pathname === '/setup') {
      if (!env.WEBHOOK_SECRET || url.searchParams.get('secret') !== env.WEBHOOK_SECRET) return text('No autorizado', 401);
      await ensureSchema(env);
      const hook = await tg(env, 'setWebhook', {
        url: `${url.origin}/telegram`, secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'], drop_pending_updates: true,
      });
      await tg(env, 'setMyCommands', { commands: [
        { command: 'webs', description: 'Mis webs y su estado' },
        { command: 'anadir', description: 'Añadir una web' },
        { command: 'comprobar', description: 'Comprobar mis webs ahora' },
        { command: 'ayuda', description: 'Cómo funciona' },
      ] });
      await tg(env, 'setMyShortDescription', { short_description: 'Vigila tus webs y te avisa aquí cuando se caen y cuando vuelven. Cada 5 minutos, gratis.' });
      await tg(env, 'setMyDescription', { description: `Te aviso por Telegram cuando una de tus webs deja de funcionar y cuando vuelve, con el tiempo que estuvo caída.

• Envíame la dirección de una web para empezar a vigilarla.
• 📋 Mis webs: el estado de cada una y un botón para quitarla.
• 🔄 Comprobar ahora: las reviso al momento.

Las compruebo cada 5 minutos. Solo tú ves tus webs.` });
      return text('Webhook: ' + JSON.stringify(hook));
    }
    if (request.method !== 'POST' || url.pathname !== '/telegram') return text('No encontrado', 404);
    if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return text('No autorizado', 401);
    const update = await request.json().catch(() => null);
    if (update) ctx.waitUntil(handleUpdate(update, env).catch(e => console.error('update', e)));
    return text('ok');
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runChecks(env, new Date(event.scheduledTime)).catch(e => console.error('cron', e)));
  },
};

/* ---------------------------------------------------------------- base de datos */

let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, up INTEGER NOT NULL DEFAULT 1,
      since INTEGER, last_check INTEGER, last_ms INTEGER, last_error TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS subs (
      chat_id INTEGER NOT NULL, site_id INTEGER NOT NULL, name TEXT NOT NULL, added INTEGER NOT NULL,
      PRIMARY KEY (chat_id, site_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY, first_seen INTEGER NOT NULL, waiting TEXT)`),
  ]);
  schemaReady = true;
}

/* ---------------------------------------------------------------- comprobaciones */

function checkUrl(site, env) {
  const hosts = (env.NOCONTAR_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  const u = new URL(site);
  if (hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) u.searchParams.set('nocontar', '');
  return u.toString().replace('nocontar=', 'nocontar');
}

async function probe(url, env, attempts = 3) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(5000);
    const t0 = Date.now();
    try {
      const r = await fetch(checkUrl(url, env), {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' }, redirect: 'follow',
        signal: AbortSignal.timeout(20000), cf: { cacheTtl: 0, cacheEverything: false },
      });
      const ms = Date.now() - t0;
      try { await r.body?.cancel(); } catch (_) {}
      if (r.status >= 200 && r.status < 400) return { ok: true, ms, detail: `${r.status} en ${ms} ms` };
      last = `error HTTP ${r.status}`;
    } catch (e) {
      last = e?.name === 'TimeoutError' ? 'no responde (20 s sin respuesta)' : `sin conexión (${String(e?.message || e).slice(0, 120)})`;
    }
  }
  return { ok: false, ms: null, detail: last };
}

async function runChecks(env, now) {
  await ensureSchema(env);
  const slot = Math.floor(now.getTime() / 60000) % SLOTS;
  const { results: sites } = await env.DB.prepare(
    'SELECT * FROM sites WHERE id % ?1 = ?2 AND EXISTS (SELECT 1 FROM subs WHERE subs.site_id = sites.id) ORDER BY last_check IS NOT NULL, last_check LIMIT ?3'
  ).bind(SLOTS, slot, MAX_PER_RUN).all();
  if (!sites.length) return;

  // Primero un intento para todas; las que fallan se reintentan (así caben más webs por pasada)
  const first = await Promise.all(sites.map(s => probe(s.url, env, 1)));
  const results = await Promise.all(sites.map((s, i) => first[i].ok ? first[i] : probe(s.url, env, 2)));

  const ts = Math.floor(now.getTime() / 1000);
  const updates = [], changed = [];
  sites.forEach((s, i) => {
    const r = results[i];
    const wasUp = !!s.up;
    if (r.ok !== wasUp) changed.push({ site: s, r, prevSince: s.since || ts });
    updates.push(env.DB.prepare('UPDATE sites SET up = ?1, since = ?2, last_check = ?3, last_ms = ?4, last_error = ?5 WHERE id = ?6')
      .bind(r.ok ? 1 : 0, r.ok !== wasUp ? ts : (s.since || ts), ts, r.ms, r.ok ? null : r.detail, s.id));
  });
  await env.DB.batch(updates);

  for (const { site, r, prevSince } of changed) {
    const { results: subs } = await env.DB.prepare('SELECT chat_id, name FROM subs WHERE site_id = ?1').bind(site.id).all();
    for (const sub of subs) {
      const msg = r.ok
        ? `✅ <b>${esc(sub.name)}</b> vuelve a funcionar\n${esc(site.url)}\nEstuvo caída ${dur(ts - prevSince)} (desde ${fmt(prevSince)}).`
        : `🔴 <b>${esc(sub.name)}</b> está caída\n${esc(site.url)}\nMotivo: ${esc(r.detail)}\nDesde ${fmt(ts)} (hora de Cuba). Te aviso cuando vuelva.`;
      await send(env, sub.chat_id, msg);
    }
  }
}

/* ---------------------------------------------------------------- bot */

async function handleUpdate(update, env) {
  await ensureSchema(env);
  if (update.callback_query) return handleCallback(update.callback_query, env);
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chat = m.chat.id;
  const msg = (m.text || '').trim();
  if (!allowed(env, m.from?.id)) return send(env, chat, 'Este bot es privado.');
  await env.DB.prepare('INSERT OR IGNORE INTO users (chat_id, first_seen) VALUES (?1, ?2)').bind(chat, now()).run();

  const cmd = msg.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const arg = msg.slice(cmd.length).trim();
  if (cmd === '/start' || cmd === '/ayuda' || cmd === '/help') return help(env, chat, cmd === '/start');
  if (cmd === '/webs' || cmd === '/list') return listSites(env, chat);
  if (cmd === '/comprobar') return checkNow(env, chat);
  if (cmd === '/anadir' || cmd === '/añadir' || cmd === '/add') {
    if (arg) return addSite(env, chat, arg);
    await setWaiting(env, chat, 'add');
    return send(env, chat, 'Envíame la dirección de la web (por ejemplo <code>midominio.com</code>). Si quieres, añade un nombre detrás: <code>midominio.com Mi tienda</code>');
  }
  if (cmd === '/cancelar') { await setWaiting(env, chat, null); return send(env, chat, 'Vale, cancelado.', mainKeyboard()); }
  if (msg === '📋 Mis webs') return listSites(env, chat);
  if (msg === '➕ Añadir web') {
    await setWaiting(env, chat, 'add');
    return send(env, chat, 'Envíame la dirección de la web (por ejemplo <code>midominio.com</code>). Si quieres, añade un nombre detrás.');
  }
  if (msg === '🔄 Comprobar ahora') return checkNow(env, chat);
  // Cualquier texto que parezca una dirección se añade
  if (looksLikeUrl(msg.split(/\s+/)[0])) return addSite(env, chat, msg);
  return send(env, chat, 'No te entendí. Envíame la dirección de una web para vigilarla, o usa los botones de abajo.', mainKeyboard());
}

async function handleCallback(q, env) {
  const chat = q.message?.chat?.id;
  const [action, id] = String(q.data || '').split(':');
  if (!chat || !allowed(env, q.from?.id)) return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  if (action === 'del') {
    const row = await env.DB.prepare('SELECT subs.name, sites.url FROM subs JOIN sites ON sites.id = subs.site_id WHERE chat_id = ?1 AND site_id = ?2').bind(chat, +id).first();
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
    if (!row) return;
    return tg(env, 'editMessageText', {
      chat_id: chat, message_id: q.message.message_id, parse_mode: 'HTML',
      text: `¿Dejo de vigilar <b>${esc(row.name)}</b>?\n${esc(row.url)}`,
      reply_markup: { inline_keyboard: [[{ text: '🗑 Sí, quitarla', callback_data: `del2:${id}` }, { text: 'No', callback_data: 'list:0' }]] },
    });
  }
  if (action === 'del2') {
    const row = await env.DB.prepare('SELECT name FROM subs WHERE chat_id = ?1 AND site_id = ?2').bind(chat, +id).first();
    await env.DB.prepare('DELETE FROM subs WHERE chat_id = ?1 AND site_id = ?2').bind(chat, +id).run();
    await env.DB.prepare('DELETE FROM sites WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM subs WHERE site_id = ?1)').bind(+id).run();
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: row ? `Quitada: ${row.name}` : 'Ya no estaba' });
    return listSites(env, chat, q.message.message_id);
  }
  if (action === 'list') { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id }); return listSites(env, chat, q.message.message_id); }
  if (action === 'check') { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Comprobando…' }); return checkNow(env, chat); }
  return tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
}

async function help(env, chat, welcome) {
  const max = maxSites(env);
  return send(env, chat,
    (welcome ? '👋 <b>Hola.</b> Vigilo tus webs y te aviso aquí cuando se caen y cuando vuelven.\n\n' : '') +
    '• <b>Añadir una web:</b> envíame su dirección (por ejemplo <code>midominio.com</code>). Puedes poner un nombre detrás: <code>midominio.com Mi tienda</code>\n' +
    '• <b>Ver tus webs y quitar alguna:</b> 📋 Mis webs (o /webs)\n' +
    '• <b>Comprobar ahora:</b> 🔄 Comprobar ahora (o /comprobar)\n\n' +
    `Las compruebo cada 5 minutos. Si una no responde en 3 intentos seguidos, te aviso 🔴, y cuando vuelve, ✅ con el tiempo que estuvo caída. Solo tú ves tus webs. Máximo ${max} webs.

<a href="https://wpdesigndev.github.io/monitor-webs/privacidad.html">Privacidad</a>`,
    mainKeyboard());
}

async function addSite(env, chat, input) {
  await setWaiting(env, chat, null);
  const [raw, ...rest] = input.trim().split(/\s+/);
  const url = normalize(raw);
  if (!url) return send(env, chat, '❌ No entendí la dirección. Escríbela así: <code>midominio.com</code> o <code>https://midominio.com/</code>', mainKeyboard());
  const name = (rest.join(' ') || new URL(url).hostname.replace(/^www\./, '')).slice(0, 60);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM subs WHERE chat_id = ?1').bind(chat).first('n');
  if (count >= maxSites(env)) return send(env, chat, `Ya tienes ${count} webs, el máximo. Quita alguna en 📋 Mis webs.`, mainKeyboard());

  await env.DB.prepare('INSERT OR IGNORE INTO sites (url, since) VALUES (?1, ?2)').bind(url, now()).run();
  const site = await env.DB.prepare('SELECT * FROM sites WHERE url = ?1').bind(url).first();
  const exists = await env.DB.prepare('SELECT 1 FROM subs WHERE chat_id = ?1 AND site_id = ?2').bind(chat, site.id).first();
  if (exists) return send(env, chat, `ℹ️ <b>${esc(name)}</b> ya estaba en tu lista.`, mainKeyboard());
  await env.DB.prepare('INSERT INTO subs (chat_id, site_id, name, added) VALUES (?1, ?2, ?3, ?4)').bind(chat, site.id, name, now()).run();

  const r = await probe(url, env, 1);
  if (!site.last_check) {
    await env.DB.prepare('UPDATE sites SET up = ?1, since = ?2, last_check = ?2, last_ms = ?3, last_error = ?4 WHERE id = ?5')
      .bind(r.ok ? 1 : 0, now(), r.ms, r.ok ? null : r.detail, site.id).run();
  }
  return send(env, chat,
    `✅ Añadida <b>${esc(name)}</b>\n${esc(url)}\n\n` +
    (r.ok ? `Ahora mismo funciona (${r.ms} ms). Te aviso si se cae.` : `⚠️ Ahora mismo no responde (${esc(r.detail)}). Te aviso cuando funcione.`),
    mainKeyboard());
}

async function listSites(env, chat, editId) {
  const { results } = await env.DB.prepare(
    'SELECT sites.*, subs.name FROM subs JOIN sites ON sites.id = subs.site_id WHERE subs.chat_id = ?1 ORDER BY subs.added'
  ).bind(chat).all();
  let body, kb;
  if (!results.length) {
    body = 'Aún no vigilas ninguna web. Envíame una dirección para añadirla.';
    kb = { inline_keyboard: [] };
  } else {
    const down = results.filter(s => !s.up).length;
    body = (down ? `🔴 <b>${down === 1 ? '1 web caída' : down + ' webs caídas'}</b>` : '🟢 <b>Todas tus webs funcionan</b>') + '\n\n' +
      results.map(s => `${s.up ? '🟢' : '🔴'} <b>${esc(s.name)}</b>\n<code>${esc(s.url)}</code>\n` +
        (s.last_check ? (s.up ? `${s.last_ms != null ? s.last_ms + ' ms · ' : ''}funciona desde ${fmt(s.since)}` : `caída desde ${fmt(s.since)} · ${esc(s.last_error || '')}`) : 'pendiente de la primera comprobación')
      ).join('\n\n');
    kb = { inline_keyboard: [
      ...results.map(s => [{ text: `🗑 Quitar ${s.name}`.slice(0, 60), callback_data: `del:${s.id}` }]),
      [{ text: '🔄 Comprobar ahora', callback_data: 'check:0' }],
    ] };
  }
  if (editId) return tg(env, 'editMessageText', { chat_id: chat, message_id: editId, text: body, parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } });
  return send(env, chat, body, kb);
}

async function checkNow(env, chat) {
  const { results } = await env.DB.prepare(
    'SELECT sites.*, subs.name FROM subs JOIN sites ON sites.id = subs.site_id WHERE subs.chat_id = ?1 ORDER BY subs.added'
  ).bind(chat).all();
  if (!results.length) return send(env, chat, 'Aún no vigilas ninguna web. Envíame una dirección para añadirla.', mainKeyboard());
  const rs = await Promise.all(results.map(s => probe(s.url, env, 1)));
  const lines = results.map((s, i) => `${rs[i].ok ? '🟢' : '🔴'} <b>${esc(s.name)}</b>: ${esc(rs[i].detail)}`);
  return send(env, chat, '<b>Comprobación ahora:</b>\n' + lines.join('\n') +
    (rs.some(r => !r.ok) ? '\n\n(Si una falla, la vigilancia la reintenta 3 veces antes de avisarte.)' : ''), mainKeyboard());
}

/* ---------------------------------------------------------------- utilidades */

function mainKeyboard() {
  return { keyboard: [[{ text: '📋 Mis webs' }, { text: '➕ Añadir web' }], [{ text: '🔄 Comprobar ahora' }]], resize_keyboard: true, is_persistent: true };
}

async function setWaiting(env, chat, v) {
  await env.DB.prepare('UPDATE users SET waiting = ?1 WHERE chat_id = ?2').bind(v, chat).run();
}

function allowed(env, userId) {
  const list = String(env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
  return !list.length || list.includes(String(userId));
}

function maxSites(env) { return Math.max(1, parseInt(env.MAX_SITES || '25', 10) || 25); }

function looksLikeUrl(s) { return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(s || ''); }

function normalize(raw) {
  let s = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  const h = u.hostname.toLowerCase();
  // Solo webs públicas con dominio (nada de IPs, localhost ni redes internas)
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h) || h.endsWith('.local') || h.endsWith('.internal') || h === 'localhost') return null;
  if (u.username || u.password) return null;
  return `${u.protocol}//${h}${u.port ? ':' + u.port : ''}${u.pathname || '/'}${u.search}`;
}

async function send(env, chat, msg, markup) {
  return tg(env, 'sendMessage', { chat_id: chat, text: msg, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) });
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('telegram', method, j.description);
  return j;
}

function fmt(ts) {
  return new Date(ts * 1000).toLocaleString('es-ES', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function dur(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const now = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const text = (t, status = 200) => new Response(t, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

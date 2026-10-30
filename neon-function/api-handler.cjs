const crypto = require("node:crypto");
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: true } : undefined,
  max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000
});
const GAME_ORIGIN = process.env.PRESIDENTIAL_GAME_ORIGIN || "https://merekwi.github.io";
const presidentialPool = process.env.PRESIDENTIAL_DATABASE_URL ? new Pool({
  connectionString: process.env.PRESIDENTIAL_DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000
}) : null;
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const COOKIE = "nettle_session", TTL = 604800;
function out(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}
function setCors(req, res) {
  const origin = req.headers.origin;
  const allowed = [process.env.SITE_ORIGIN, GAME_ORIGIN].filter(Boolean);
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Vary", "Origin");
  }
}
function sameOrigin(req) {
  return !!process.env.SITE_ORIGIN && req.headers.origin === process.env.SITE_ORIGIN &&
    req.headers.origin.startsWith("https://");
}
function readBody(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string" && req.body.length) { try { return Promise.resolve(JSON.parse(req.body)); } catch (_) { return Promise.reject(new Error("bad_json")); } }
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; if (raw.length > 32768) { reject(new Error("too_large")); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}
function validHex(a,b) {
  if (typeof a !== "string" || !/^[a-f0-9]{64}$/i.test(a)) return false;
  const x = Buffer.from(a,"hex"), y = Buffer.from(b,"hex");
  return x.length === y.length && crypto.timingSafeEqual(x,y);
}
function verifyTelegram(data) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !data || typeof data !== "object" || Array.isArray(data)) return null;
  const id = String(data.id || ""), authDate = Number(data.auth_date);
  const now = Math.floor(Date.now()/1000);
  if (!/^\d{1,20}$/.test(id) || !Number.isInteger(authDate) || authDate > now + 30 || now-authDate > 600) return null;
  const check = Object.keys(data).filter(k => k !== "hash" && data[k] != null).sort().map(k => k+"="+String(data[k])).join("\n");
  const secret = crypto.createHash("sha256").update(token).digest();
  const expected = crypto.createHmac("sha256",secret).update(check).digest("hex");
  if (!validHex(data.hash,expected)) return null;
  return { id, username: typeof data.username === "string" ? data.username.slice(0,64) : null,
    name: ((typeof data.first_name === "string" ? data.first_name : "")+" "+(typeof data.last_name === "string" ? data.last_name : "")).trim().slice(0,120) || "Пользователь" };
}
function issue(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256",secret).update(data).digest("base64url");
  return data+"."+sig;
}
function session(req) {
  const raw = (req.headers.cookie || "").split(";").map(v=>v.trim()).find(v=>v.startsWith(COOKIE+"="));
  if (!raw || !process.env.SESSION_SECRET) return null;
  let token; try { token = decodeURIComponent(raw.slice(COOKIE.length+1)); } catch (_) { return null; }
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac("sha256",process.env.SESSION_SECRET).update(parts[0]).digest();
  const actual = Buffer.from(parts[1],"base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected)) return null;
  try { const p=JSON.parse(Buffer.from(parts[0],"base64url").toString()); return p.exp > Math.floor(Date.now()/1000) && /^\d{1,20}$/.test(String(p.tg)) ? String(p.tg) : null; } catch (_) { return null; }
}
async function userFor(req) {
  const id = session(req); if (!id) return null;
  const r = await pool.query("SELECT id,telegram_id::text,telegram_username,display_name,is_admin FROM public.user_profiles WHERE telegram_id=$1",[id]);
  return r.rows[0] || null;
}
function txt(v,n) { return typeof v === "string" ? v.trim().slice(0,n) : ""; }
async function main(req,res,forcedPath) {
  const path = forcedPath || (new URL(req.url,"https://localhost").pathname.replace(/\/+$/,"") || "/");
  setCors(req,res);
  if (req.method === "OPTIONS") {
    const origins = path.startsWith("/api/presidential/") ? [process.env.SITE_ORIGIN, GAME_ORIGIN] : [process.env.SITE_ORIGIN];
    if (!req.headers.origin || !origins.includes(req.headers.origin)) return out(res,403,{error:"origin_check_failed"});
    res.statusCode=204; res.setHeader("Allow","GET, POST, PATCH, OPTIONS"); return res.end();
  }

  // Presidential Simulator endpoints reuse the Telegram bot already connected to Nettle Group.
  // The login widget runs on SITE_ORIGIN; the game itself calls this API from GAME_ORIGIN.
  if (path.startsWith("/api/presidential/")) {
    if (!presidentialPool) return out(res,503,{error:"presidential_database_not_configured"});
    const loginRoute = path === "/api/presidential/auth/telegram";
    const expectedOrigin = loginRoute ? process.env.SITE_ORIGIN : GAME_ORIGIN;
    if (!expectedOrigin || req.headers.origin !== expectedOrigin) return out(res,403,{error:"origin_check_failed"});

    if (loginRoute && req.method === "POST") {
      const payload = await readBody(req);
      const state = txt(payload.state,128);
      const telegramData = { ...payload };
      delete telegramData.state;
      const identity = verifyTelegram(telegramData);
      if (!/^[A-Za-z0-9_-]{40,128}$/.test(state)) return out(res,400,{error:"invalid_login_state"});
      if (!identity) return out(res,401,{error:"telegram_signature_invalid_or_expired"});
      const code = crypto.randomBytes(32).toString("hex");
      await presidentialPool.query(
        "INSERT INTO telegram_login_codes(code_hash,state_hash,telegram_id,telegram_username,first_name,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '3 minutes')",
        [digest(code),digest(state),identity.id,identity.username,identity.name]
      );
      await presidentialPool.query("DELETE FROM telegram_login_codes WHERE expires_at < now()-interval '1 day'");
      return out(res,200,{ok:true,code,expiresIn:180});
    }

    if (path === "/api/presidential/auth/exchange" && req.method === "POST") {
      const payload = await readBody(req);
      const code = txt(payload.code,64), state = txt(payload.state,128);
      if (!/^[a-f0-9]{64}$/i.test(code) || !/^[A-Za-z0-9_-]{40,128}$/.test(state)) return out(res,400,{error:"invalid_login_code"});
      const client = await presidentialPool.connect();
      const token = crypto.randomBytes(32).toString("hex");
      try {
        await client.query("BEGIN");
        const redeemed = await client.query(
          "UPDATE telegram_login_codes SET consumed_at=now() WHERE code_hash=$1 AND state_hash=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING telegram_id::text,telegram_username,first_name",
          [digest(code),digest(state)]
        );
        if (!redeemed.rowCount) {
          await client.query("ROLLBACK");
          return out(res,401,{error:"login_code_expired_or_used"});
        }
        const identity = redeemed.rows[0];
        const userResult = await client.query(
          "INSERT INTO game_users(telegram_id,telegram_username,first_name,last_login_at,updated_at) VALUES($1,$2,$3,now(),now()) ON CONFLICT(telegram_id) DO UPDATE SET telegram_username=EXCLUDED.telegram_username,first_name=EXCLUDED.first_name,last_login_at=now(),updated_at=now() RETURNING id,telegram_id::text,telegram_username,first_name",
          [identity.telegram_id,identity.telegram_username,identity.first_name]
        );
        const user = userResult.rows[0];
        await client.query(
          "INSERT INTO game_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '7 days')",
          [user.id,digest(token)]
        );
        await client.query("COMMIT");
        return out(res,200,{token,expiresIn:604800,user:{id:user.id,telegramId:user.telegram_id,username:user.telegram_username,firstName:user.first_name}});
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    const bearerMatch = /^Bearer ([a-f0-9]{64})$/i.exec(String(req.headers.authorization || ""));
    const bearer = bearerMatch ? bearerMatch[1] : null;
    const gameUser = bearer ? (await presidentialPool.query(
      "SELECT u.id,u.telegram_id::text,u.telegram_username,u.first_name FROM game_sessions s JOIN game_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [digest(bearer)]
    )).rows[0] : null;

    if (path === "/api/presidential/me" && req.method === "GET") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      return out(res,200,{authenticated:true,user:{id:gameUser.id,telegramId:gameUser.telegram_id,username:gameUser.telegram_username,firstName:gameUser.first_name}});
    }

    if (path === "/api/presidential/auth/logout" && req.method === "POST") {
      if (!bearer) return out(res,401,{error:"authentication_required"});
      await presidentialPool.query("DELETE FROM game_sessions WHERE token_hash=$1",[digest(bearer)]);
      return out(res,200,{ok:true});
    }

    if (path === "/api/presidential/game/current" && req.method === "GET") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const result = await presidentialPool.query(
        "SELECT s.id,s.save_name,s.president_name,s.president_age,s.president_bio,s.game_date,s.turn_number,s.state,s.status,c.iso2,c.name_en,c.name_local,c.flag_emoji,c.government_type,c.region FROM game_saves s LEFT JOIN countries c ON c.id=s.country_id WHERE s.owner_user_id=$1 AND s.status='active' ORDER BY s.updated_at DESC LIMIT 1",
        [gameUser.telegram_id]
      );
      return out(res,200,{game:result.rows[0] || null});
    }

    if (path === "/api/presidential/game/new" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const countryResult = await presidentialPool.query("SELECT * FROM countries WHERE iso2 IS NOT NULL ORDER BY random() LIMIT 1");
      if (!countryResult.rowCount) return out(res,503,{error:"country_catalog_empty"});
      const country = countryResult.rows[0];
      const baseline = country.baseline_state || {};
      const firstNames = ["Александр","Даниэль","Маркос","Эмиль","София","Михаил","Адриан","Лука","Елена","Николай","Томас","Амелия"];
      const lastNames = ["Новский","Петров","Альварес","ван дер Берг","Марин","Ковач","Морено","Сантос","Иванов","Шмидт","Коваль","Ромеро"];
      const president = firstNames[crypto.randomInt(firstNames.length)]+" "+lastNames[crypto.randomInt(lastNames.length)];
      const age = crypto.randomInt(35,66);
      const state = {
        gdp: Number(baseline.gdp || 350),
        gdpGrowth: Number(baseline.gdpGrowth || 2.1),
        inflation: Number(baseline.inflation || 3.2),
        unemployment: Number(baseline.unemployment || 5.4),
        approval: crypto.randomInt(46,62),
        stability: crypto.randomInt(62,79),
        budgetBalance: Number(baseline.budgetBalance || 0),
        treasury: Number(baseline.treasury || 30),
        population: Number(baseline.population || 25),
        militaryPower: Number(baseline.militaryPower || 48),
        publicServices: 58,
        corruption: 34,
        debt: Number(baseline.debt || 55),
        taxRate: Number(baseline.taxRate || 22)
      };
      const client = await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE game_saves SET status='finished',updated_at=now() WHERE owner_user_id=$1 AND status='active'",[gameUser.telegram_id]);
        const saveResult = await client.query(
          "INSERT INTO game_saves(owner_user_id,save_name,country_id,president_name,president_age,president_bio,game_date,turn_number,state,status) VALUES($1,$2,$3,$4,$5,$6,'2026-01-01',1,$7::jsonb,'active') RETURNING id,save_name,president_name,president_age,president_bio,game_date,turn_number,state,status",
          [gameUser.telegram_id,country.name_local || country.name_en,country.id,president,age,"Глава государства. Политическая карьера началась до избрания.",JSON.stringify(state)]
        );
        const save = saveResult.rows[0];
        const ministerNames = ["Ирина Волкова","Андрей Коваль","Мария Новак","Дмитрий Соколов","Лаура Мартинес"];
        const portfolios = ["Финансы","Иностранные дела","Оборона","Экономика","Здравоохранение"];
        for (let i=0;i<portfolios.length;i++) {
          await client.query("INSERT INTO ministers(save_id,portfolio,full_name,age,competence,loyalty,approval,traits) VALUES($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb)",[save.id,portfolios[i],ministerNames[i],crypto.randomInt(38,61),crypto.randomInt(48,86),crypto.randomInt(45,88),crypto.randomInt(42,72)]);
        }
        const neighbours = await client.query("SELECT name_local,name_en FROM countries WHERE id<>$1 ORDER BY random() LIMIT 4",[country.id]);
        for (const n of neighbours.rows) {
          await client.query("INSERT INTO diplomatic_relations(save_id,other_country_name,relation_score,status,treaties) VALUES($1,$2,$3,'neutral','[]'::jsonb)",[save.id,n.name_local || n.name_en,crypto.randomInt(-18,32)]);
        }
        for (const unit of [["Сухопутные войска",42000],["Военно-воздушные силы",170],["Военно-морские силы",24],["Национальная гвардия",12000]]) {
          await client.query("INSERT INTO military_units(save_id,unit_type,quantity,readiness,supply) VALUES($1,$2,$3,$4,$5)",[save.id,unit[0],unit[1],crypto.randomInt(55,84),crypto.randomInt(58,90)]);
        }
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,'2026-01-01','inauguration',$2,$3,2,'{}'::jsonb)",[save.id,"Новый президент вступил в должность","В стране состоялась церемония вступления нового главы государства. Правительство приступает к формированию политической программы."]);
        await client.query("COMMIT");
        return out(res,201,{game:{...save,iso2:country.iso2,name_en:country.name_en,name_local:country.name_local,flag_emoji:country.flag_emoji,government_type:country.government_type,region:country.region}});
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    return out(res,404,{error:"not_found"});
  }
  if (path === "/api/auth/telegram" && req.method === "POST") {
    if (!sameOrigin(req)) return out(res,403,{error:"origin_check_failed"});
    const data = await readBody(req), ident = verifyTelegram(data);
    if (!ident) return out(res,401,{error:"telegram_signature_invalid_or_expired"});
    const adminId=String(process.env.INITIAL_ADMIN_TELEGRAM_ID||"");
    if (!/^\d{1,20}$/.test(adminId)) throw new Error("INITIAL_ADMIN_TELEGRAM_ID is not configured");
    const r=await pool.query("INSERT INTO public.user_profiles(telegram_id,telegram_username,display_name,is_admin) VALUES($1,$2,$3,$1=$4::bigint) ON CONFLICT(telegram_id) DO UPDATE SET telegram_username=EXCLUDED.telegram_username,display_name=EXCLUDED.display_name,is_admin=public.user_profiles.is_admin OR EXCLUDED.is_admin,updated_at=now() RETURNING id,telegram_id::text,telegram_username,display_name,is_admin",[ident.id,ident.username,ident.name,adminId]);
    const u=r.rows[0], token=issue({tg:u.telegram_id,exp:Math.floor(Date.now()/1000)+TTL});
    const cookieDomain = process.env.COOKIE_DOMAIN ? "; Domain=" + process.env.COOKIE_DOMAIN : "";
    res.setHeader("Set-Cookie",COOKIE+"="+encodeURIComponent(token)+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age="+TTL+cookieDomain);
    return out(res,200,{user:{id:u.id,telegramId:u.telegram_id,username:u.telegram_username,displayName:u.display_name,isAdmin:u.is_admin}});
  }
  if (path === "/api/auth/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return out(res,403,{error:"origin_check_failed"});
    const cookieDomain = process.env.COOKIE_DOMAIN ? "; Domain=" + process.env.COOKIE_DOMAIN : "";
    res.setHeader("Set-Cookie",COOKIE+"=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"+cookieDomain);
    return out(res,200,{ok:true});
  }
  if (path === "/api/session" && req.method === "GET") {
    const u=await userFor(req);
    return out(res,200,{authenticated:!!u,user:u?{id:u.id,telegramId:u.telegram_id,username:u.telegram_username,displayName:u.display_name,isAdmin:u.is_admin}:null});
  }
  if (path === "/api/services" && req.method === "GET") {
    const r=await pool.query("SELECT id,slug,title,description,price_label,duration_days FROM public.service_catalog WHERE is_active=true ORDER BY sort_order,id");
    return out(res,200,{services:r.rows});
  }
  if (path === "/api/payment-methods" && req.method === "GET") {
    const r=await pool.query("SELECT id,title,instructions,payment_details FROM public.payment_methods WHERE is_active=true ORDER BY sort_order,id");
    return out(res,200,{paymentMethods:r.rows});
  }
  const u=await userFor(req);
  if (!u) return out(res,401,{error:"authentication_required"});
  if (path === "/api/tickets" && req.method === "GET") {
    const r=u.is_admin
      ? await pool.query("SELECT t.id,t.order_code,t.amount_label,t.payment_reference,t.user_comment,t.status,t.admin_comment,t.created_at,u.telegram_id::text,u.telegram_username,u.display_name,s.title AS service_title,p.title AS payment_method FROM public.payment_tickets t JOIN public.user_profiles u ON u.id=t.user_id LEFT JOIN public.service_catalog s ON s.id=t.service_id LEFT JOIN public.payment_methods p ON p.id=t.payment_method_id ORDER BY t.created_at DESC LIMIT 200")
      : await pool.query("SELECT t.id,t.order_code,t.amount_label,t.payment_reference,t.user_comment,t.status,t.admin_comment,t.created_at,s.title AS service_title,p.title AS payment_method FROM public.payment_tickets t LEFT JOIN public.service_catalog s ON s.id=t.service_id LEFT JOIN public.payment_methods p ON p.id=t.payment_method_id WHERE t.user_id=$1 ORDER BY t.created_at DESC LIMIT 100",[u.id]);
    return out(res,200,{tickets:r.rows});
  }
  if (path === "/api/tickets" && req.method === "POST") {
    if (!sameOrigin(req)) return out(res,403,{error:"origin_check_failed"});
    const d=await readBody(req), sid=Number(d.serviceId), mid=Number(d.paymentMethodId);
    if (!Number.isSafeInteger(sid)||sid<1||!Number.isSafeInteger(mid)||mid<1) return out(res,400,{error:"service_and_payment_method_required"});
    const s=await pool.query("SELECT id,price_label FROM public.service_catalog WHERE id=$1 AND is_active=true",[sid]);
    const m=await pool.query("SELECT id FROM public.payment_methods WHERE id=$1 AND is_active=true",[mid]);
    if (!s.rowCount||!m.rowCount) return out(res,400,{error:"service_or_payment_method_unavailable"});
    const code="NG-"+crypto.randomBytes(6).toString("hex").toUpperCase();
    const r=await pool.query("INSERT INTO public.payment_tickets(order_code,user_id,service_id,payment_method_id,amount_label,user_comment) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,order_code,status,amount_label,created_at",[code,u.id,sid,mid,s.rows[0].price_label,txt(d.comment,1000)]);
    return out(res,201,{ticket:r.rows[0]});
  }
  if (path === "/api/ticket-paid" && req.method === "POST") {
    if (!sameOrigin(req)) return out(res,403,{error:"origin_check_failed"});
    const d=await readBody(req), ticketId=Number(d.ticketId);
    if (!Number.isSafeInteger(ticketId)||ticketId<1) return out(res,400,{error:"ticket_id_required"});
    const r=await pool.query("UPDATE public.payment_tickets SET status='paid_submitted',payment_reference=$1,updated_at=now() WHERE id=$2 AND user_id=$3 AND status='awaiting_payment' RETURNING id,order_code,status",[txt(d.paymentReference,300),ticketId,u.id]);
    if (!r.rowCount) return out(res,409,{error:"ticket_not_found_or_not_awaiting_payment"});
    return out(res,200,{ticket:r.rows[0],notice:"Заявка отправлена администратору; оплата ещё не подтверждена."});
  }
  if (!u.is_admin) return out(res,403,{error:"admin_required"});
  if (!sameOrigin(req)) return out(res,403,{error:"origin_check_failed"});
  if (path === "/api/admin/ticket-decision" && req.method === "POST") {
    const d=await readBody(req), decision=d.decision, comment=txt(d.comment,1000), ticketId=Number(d.ticketId);
    if (!Number.isSafeInteger(ticketId)||ticketId<1) return out(res,400,{error:"ticket_id_required"});
    if (!["approved","rejected"].includes(decision)) return out(res,400,{error:"invalid_decision"});
    if (decision==="rejected"&&!comment) return out(res,400,{error:"rejection_comment_required"});
    const c=await pool.connect();
    try {
      await c.query("BEGIN");
      const t=await c.query("SELECT * FROM public.payment_tickets WHERE id=$1 FOR UPDATE",[ticketId]);
      if (!t.rowCount) { await c.query("ROLLBACK"); return out(res,404,{error:"ticket_not_found"}); }
      const row=t.rows[0];
      if (row.status!=="paid_submitted") { await c.query("ROLLBACK"); return out(res,409,{error:"ticket_not_pending_review"}); }
      const result=await c.query("UPDATE public.payment_tickets SET status=$1,admin_comment=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$4 RETURNING id,order_code,status,admin_comment",[decision,comment,u.id,row.id]);
      if (decision==="approved") {
        const s=row.service_id ? await c.query("SELECT duration_days FROM public.service_catalog WHERE id=$1",[row.service_id]) : {rows:[]};
        const days=s.rows.length?s.rows[0].duration_days:null;
        await c.query("INSERT INTO public.service_grants(user_id,service_id,ticket_id,granted_by,starts_at,expires_at,status,note) VALUES($1,$2,$3,$4,now(),CASE WHEN $5::int IS NULL THEN NULL ELSE now()+($5::text||' days')::interval END,'active',$6)",[row.user_id,row.service_id,row.id,u.id,days,"Одобрено по заказу "+row.order_code]);
      }
      await c.query("INSERT INTO public.audit_logs(actor_user_id,action,entity_type,entity_id,details) VALUES($1,$2,'payment_ticket',$3,$4::jsonb)",[u.id,"ticket_"+decision,String(row.id),JSON.stringify({orderCode:row.order_code,comment})]);
      await c.query("COMMIT"); return out(res,200,{ticket:result.rows[0]});
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  if (path === "/api/admin/services" && req.method === "POST") {
    const d=await readBody(req), slug=txt(d.slug,80).toLowerCase(), title=txt(d.title,160);
    const days=d.durationDays==null||d.durationDays===""?null:Number(d.durationDays);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)||!title||(days!==null&&(!Number.isInteger(days)||days<1||days>36500))) return out(res,400,{error:"invalid_service_fields"});
    let r;
    try {
      r=await pool.query("INSERT INTO public.service_catalog(slug,title,description,price_label,duration_days,is_active,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[slug,title,txt(d.description,2000),txt(d.priceLabel,100),days,d.isActive!==false,Number.isInteger(d.sortOrder)?d.sortOrder:0]);
    } catch (e) {
      if (e && e.code === "23505" && e.constraint === "service_catalog_slug_key") {
        return out(res,409,{error:"service_slug_already_exists"});
      }
      throw e;
    }
    await pool.query("INSERT INTO public.audit_logs(actor_user_id,action,entity_type,entity_id,details) VALUES($1,'service_created','service_catalog',$2,$3::jsonb)",[u.id,String(r.rows[0].id),JSON.stringify({slug,title})]);
    return out(res,201,{service:r.rows[0]});
  }
  if (path === "/api/admin/service-update" && req.method === "POST") {
    const d=await readBody(req), serviceId=Number(d.id);
    if (!Number.isSafeInteger(serviceId)||serviceId<1) return out(res,400,{error:"service_id_required"});
    const r=await pool.query("UPDATE public.service_catalog SET title=COALESCE($1,title),description=COALESCE($2,description),price_label=COALESCE($3,price_label),duration_days=CASE WHEN $4 THEN $5 ELSE duration_days END,is_active=COALESCE($6,is_active),sort_order=COALESCE($7,sort_order),updated_at=now() WHERE id=$8 RETURNING *",[d.title==null?null:txt(d.title,160),d.description==null?null:txt(d.description,2000),d.priceLabel==null?null:txt(d.priceLabel,100),Object.prototype.hasOwnProperty.call(d,"durationDays"),d.durationDays==null||d.durationDays===""?null:Number(d.durationDays),typeof d.isActive==="boolean"?d.isActive:null,Number.isInteger(d.sortOrder)?d.sortOrder:null,serviceId]);
    if (!r.rowCount) return out(res,404,{error:"service_not_found"});
    return out(res,200,{service:r.rows[0]});
  }
  if (path === "/api/admin/payment-methods" && req.method === "POST") {
    const d=await readBody(req), title=txt(d.title,160);
    if (!title) return out(res,400,{error:"title_required"});
    const r=await pool.query("INSERT INTO public.payment_methods(title,instructions,payment_details,is_active,sort_order) VALUES($1,$2,$3,$4,$5) RETURNING *",[title,txt(d.instructions,3000),txt(d.paymentDetails,1000),d.isActive!==false,Number.isInteger(d.sortOrder)?d.sortOrder:0]);
    await pool.query("INSERT INTO public.audit_logs(actor_user_id,action,entity_type,entity_id,details) VALUES($1,'payment_method_created','payment_methods',$2,$3::jsonb)",[u.id,String(r.rows[0].id),JSON.stringify({title})]);
    return out(res,201,{paymentMethod:r.rows[0]});
  }
  if (path === "/api/admin/payment-method-update" && req.method === "POST") {
    const d=await readBody(req), methodId=Number(d.id);
    if (!Number.isSafeInteger(methodId)||methodId<1) return out(res,400,{error:"payment_method_id_required"});
    const r=await pool.query("UPDATE public.payment_methods SET title=COALESCE($1,title),instructions=COALESCE($2,instructions),payment_details=COALESCE($3,payment_details),is_active=COALESCE($4,is_active),sort_order=COALESCE($5,sort_order),updated_at=now() WHERE id=$6 RETURNING *",[d.title==null?null:txt(d.title,160),d.instructions==null?null:txt(d.instructions,3000),d.paymentDetails==null?null:txt(d.paymentDetails,1000),typeof d.isActive==="boolean"?d.isActive:null,Number.isInteger(d.sortOrder)?d.sortOrder:null,methodId]);
    if (!r.rowCount) return out(res,404,{error:"payment_method_not_found"});
    return out(res,200,{paymentMethod:r.rows[0]});
  }
  if (path === "/api/admin/grants" && req.method === "GET") {
    const r=await pool.query("SELECT g.*,u.telegram_id::text,u.telegram_username,u.display_name,s.title AS service_title FROM public.service_grants g JOIN public.user_profiles u ON u.id=g.user_id LEFT JOIN public.service_catalog s ON s.id=g.service_id ORDER BY g.created_at DESC LIMIT 200");
    return out(res,200,{grants:r.rows});
  }
  if (path === "/api/admin/grants" && req.method === "POST") {
    const d=await readBody(req), tg=String(d.telegramId||""), sid=d.serviceId==null||d.serviceId===""?null:Number(d.serviceId), days=d.durationDays==null||d.durationDays===""?null:Number(d.durationDays);
    if (!/^\d{1,20}$/.test(tg)||(days!==null&&(!Number.isInteger(days)||days<1||days>36500))) return out(res,400,{error:"invalid_grant_fields"});
    const target=await pool.query("SELECT id FROM public.user_profiles WHERE telegram_id=$1",[tg]);
    if (!target.rowCount) return out(res,404,{error:"user_must_sign_in_first"});
    const c=await pool.connect();
    try {
      await c.query("BEGIN");
      const r=await c.query("INSERT INTO public.service_grants(user_id,service_id,granted_by,starts_at,expires_at,status,note) VALUES($1,$2,$3,now(),CASE WHEN $4::int IS NULL THEN NULL ELSE now()+($4::text||' days')::interval END,'active',$5) RETURNING *",[target.rows[0].id,sid,u.id,days,txt(d.note,1000)]);
      await c.query("INSERT INTO public.audit_logs(actor_user_id,action,entity_type,entity_id,details) VALUES($1,'manual_grant_created','service_grant',$2,$3::jsonb)",[u.id,String(r.rows[0].id),JSON.stringify({telegramId:tg,serviceId:sid,days})]);
      await c.query("COMMIT"); return out(res,201,{grant:r.rows[0]});
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  return out(res,404,{error:"not_found"});
}
module.exports = async (req,res,forcedPath) => {
  try {
    if (!process.env.DATABASE_URL) return out(res,500,{error:"DATABASE_URL_not_configured"});
    await main(req,res,forcedPath);
  } catch(e) {
    console.error("Nettle API error:",e && e.message ? e.message : "unknown");
    if (!res.headersSent) out(res,e.message==="bad_json"?400:500,{error:e.message==="bad_json"?"invalid_json":"internal_server_error"});
    else if (!res.writableEnded) res.end();
  }
};
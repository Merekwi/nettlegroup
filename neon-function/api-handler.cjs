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

function clampNumber(value, min, max) {
  const n = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(n) ? n : 0));
}
function assessPolicy(order, state) {
  const text = String(order || "").toLowerCase();
  const gdp = clampNumber(state.gdp || 350, 1, 100000000);
  const effect = { category: "general", budgetCost: 0, budgetRevenue: 0, approval: 0.3, stability: 0.2, gdpGrowth: 0, inflation: 0, unemployment: 0, publicServices: 0, militaryPower: 0, corruption: 0, taxRate: 0 };
  if (/здрав|больниц|медицин|врач|клиник|health|hospital|medical/.test(text)) {
    effect.category="health"; effect.budgetCost=+(gdp*0.003).toFixed(2); effect.approval=3; effect.stability=1.2; effect.publicServices=5; effect.gdpGrowth=0.05;
  } else if (/образован|школ|университет|учител|education|school|university/.test(text)) {
    effect.category="education"; effect.budgetCost=+(gdp*0.0025).toFixed(2); effect.approval=2.5; effect.publicServices=4; effect.gdpGrowth=0.12; effect.unemployment=-0.05;
  } else if (/налог|ставк.*ндс|tax/.test(text) && /сниз|уменьш|сократ|reduce|lower|cut/.test(text)) {
    effect.category="tax_cut"; effect.budgetCost=+(gdp*0.002).toFixed(2); effect.approval=2; effect.gdpGrowth=0.18; effect.inflation=0.08; effect.taxRate=-1;
  } else if (/налог|tax/.test(text) && /повыс|увелич|поднять|raise|increase/.test(text)) {
    effect.category="tax_increase"; effect.budgetRevenue=+(gdp*0.003).toFixed(2); effect.approval=-2; effect.stability=-0.3; effect.inflation=-0.05; effect.taxRate=1;
  } else if (/арм|оборон|вооруж|военн|military|defen[cs]e|army/.test(text)) {
    effect.category="defense"; effect.budgetCost=+(gdp*0.004).toFixed(2); effect.approval=0.4; effect.stability=0.4; effect.militaryPower=3.5;
  } else if (/дорог|мост|инфраструкт|строительств|железн|транспорт|infrastructure|road|rail/.test(text)) {
    effect.category="infrastructure"; effect.budgetCost=+(gdp*0.004).toFixed(2); effect.approval=1.5; effect.stability=0.5; effect.gdpGrowth=0.25; effect.unemployment=-0.25;
  } else if (/коррупц|взятк|прозрачност|аудит|corruption|anti-corruption/.test(text)) {
    effect.category="anti_corruption"; effect.budgetCost=+(gdp*0.0007).toFixed(2); effect.approval=2.5; effect.stability=1.4; effect.corruption=-5; effect.gdpGrowth=0.08;
  } else if (/зарплат|пенси|пособ|субсиди|социальн|wage|pension|benefit|subsid/.test(text)) {
    effect.category="social"; effect.budgetCost=+(gdp*0.0025).toFixed(2); effect.approval=2.8; effect.stability=0.8; effect.inflation=0.15; effect.unemployment=-0.08;
  } else if (/энерг|электр|эколог|климат|энерго|energy|environment|climate/.test(text)) {
    effect.category="energy_environment"; effect.budgetCost=+(gdp*0.002).toFixed(2); effect.approval=1.2; effect.gdpGrowth=0.16; effect.publicServices=1.5;
  } else if (/внешн|дипломат|торгов|экспорт|импорт|соглашен|договор|foreign|diplomac|trade|export|import|treaty/.test(text)) {
    effect.category="foreign_policy"; effect.budgetCost=+(gdp*0.0005).toFixed(2); effect.approval=0.5; effect.stability=0.6; effect.gdpGrowth=0.12;
  } else {
    effect.budgetCost=+(gdp*0.0005).toFixed(2);
  }
  return effect;
}
async function draftOfficialDocument(order, game, effects) {
  const fallbackTitle = ({
    health:"О мерах по развитию системы здравоохранения",
    education:"О развитии национальной системы образования",
    tax_cut:"О корректировке налоговой политики",
    tax_increase:"О внесении изменений в налоговую систему",
    defense:"О развитии обороноспособности государства",
    infrastructure:"О реализации программы развития инфраструктуры",
    anti_corruption:"О мерах по противодействию коррупции",
    social:"О мерах социальной поддержки населения",
    energy_environment:"О развитии энергетики и охране окружающей среды",
    foreign_policy:"О мерах по развитию внешнеэкономического сотрудничества",
    general:"О мерах государственной политики"
  })[effects.category] || "О мерах государственной политики";
  const fallback = {
    title:fallbackTitle,
    summary:"Проект подготовлен по инициативе президента. Финансовые и социально-экономические последствия будут пересмотрены по итогам исполнения.",
    body:"В целях реализации государственной политики и обеспечения устойчивого развития постановляю:\n\n1. Утвердить инициативу: «"+order+"».\n\n2. Правительству и профильным министерствам в течение 30 дней подготовить план реализации, источники финансирования и измеримые показатели эффективности.\n\n3. Министерству финансов обеспечить контроль бюджетных обязательств в пределах утверждённых ассигнований.\n\n4. Представить президенту доклад о ходе исполнения через 90 дней."
  };
  const apiKey=process.env.OPENROUTER_API_KEY;
  const model=process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) return fallback;
  try {
    const response=await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json","HTTP-Referer":"https://merekwi.github.io/presedento-sim/","X-Title":"Presidential Simulator"},
      body:JSON.stringify({
        model,
        temperature:0.35,
        max_tokens:900,
        messages:[
          {role:"system",content:"Ты юридический редактор вымышленной политической стратегии. Составляй официальный проект указа на русском языке. Не выдумывай числовые экономические последствия. Возвращай только JSON с полями title, summary, body. body должен содержать преамбулу и пронумерованные пункты."},
          {role:"user",content:JSON.stringify({country:game.name_local||game.name_en,president:game.president_name,initiative:order,returnSchema:{title:"string",summary:"string",body:"string"}})}
        ]
      }),
      signal:AbortSignal.timeout(25000)
    });
    if (!response.ok) throw new Error("OpenRouter HTTP "+response.status);
    const payload=await response.json();
    const content=payload.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const clean=String(content).replace(/^\s*```(?:json)?/i,"").replace(/```\s*$/,"").trim();
    const parsed=JSON.parse(clean);
    return {
      title:typeof parsed.title==="string"&&parsed.title.trim()?parsed.title.trim().slice(0,220):fallback.title,
      summary:typeof parsed.summary==="string"?parsed.summary.trim().slice(0,1200):fallback.summary,
      body:typeof parsed.body==="string"&&parsed.body.trim()?parsed.body.trim().slice(0,12000):fallback.body
    };
  } catch (error) {
    console.error("OpenRouter decree draft failed:",error.message);
    return fallback;
  }
}

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

    if (path === "/api/presidential/health" && req.method === "GET") {
      const dbCheck=await presidentialPool.query("SELECT count(*)::int AS country_count FROM countries");
      return out(res,200,{ok:true,database:true,countryCount:dbCheck.rows[0].country_count});
    }

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

    if (path === "/api/presidential/game/setup" && req.method === "GET") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const countries = await presidentialPool.query(
        "SELECT id,iso2,name_en,name_local,flag_emoji,government_type,region,baseline_state FROM countries WHERE iso2 IS NOT NULL ORDER BY name_local NULLS LAST,name_en"
      );
      return out(res,200,{countries:countries.rows});
    }

    if (path === "/api/presidential/game/election/campaign" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req), action=txt(input.action,40);
      const operations = {
        rally:{support:4,cost:0.18,approval:0.25,headline:"Партия провела встречи с избирателями",article:"Кандидат посетил регионы страны и представил программу местным жителям."},
        debate:{support:4,cost:0.08,approval:0.2,headline:"Состоялись публичные предвыборные дебаты",article:"Кандидаты ответили на вопросы журналистов и представили позиции по ключевым реформам."},
        manifesto:{support:3,cost:0.12,approval:0.15,headline:"Опубликована предвыборная программа",article:"Партия представила программу экономических, социальных и институциональных преобразований."},
        coalition:{support:5,cost:0.3,approval:0.2,headline:"Заключено предвыборное коалиционное соглашение",article:"Политические силы договорились о совместной платформе и поддержке кандидата."}
      };
      const operation=operations[action];
      if (!operation) return out(res,400,{error:"invalid_campaign_action"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})}, election={...(state.election||{})};
        if (!["election_campaign","election"].includes(state.phase)) { await client.query("ROLLBACK"); return out(res,409,{error:"no_active_election"}); }
        const remaining=Number(election.actionsRemaining||0);
        if (remaining<1) { await client.query("ROLLBACK"); return out(res,409,{error:"campaign_actions_exhausted"}); }
        const cost=Number(operation.cost.toFixed(2));
        if (Number(state.treasury||0)<cost) { await client.query("ROLLBACK"); return out(res,409,{error:"insufficient_campaign_funds",required:cost,available:state.treasury}); }
        state.treasury=Number((Number(state.treasury)-cost).toFixed(2));
        state.budgetBalance=Number((Number(state.budgetBalance||0)-cost).toFixed(2));
        election.candidateSupport=Number(clampNumber(Number(election.candidateSupport||0)+operation.support,0,78).toFixed(2));
        election.actionsRemaining=remaining-1;
        election.actionsTaken=[...(Array.isArray(election.actionsTaken)?election.actionsTaken:[]),action];
        election.lastAction=action;
        state.election=election;
        state.approval=Number(clampNumber(Number(state.approval||50)+operation.approval,0,100).toFixed(2));
        await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(state),game.id]);
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'campaign',$3,$4,1,$5::jsonb)",[game.id,game.game_date,operation.headline,operation.article,JSON.stringify({action,cost,supportGain:operation.support,remaining:election.actionsRemaining})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'election_campaign_action',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({action,cost,support:election.candidateSupport,remaining:election.actionsRemaining})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,election,treasury:state.treasury,headline:operation.headline});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/election/commission" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})}, election={...(state.election||{})};
        if (!["election_campaign","election"].includes(state.phase)) { await client.query("ROLLBACK"); return out(res,409,{error:"no_active_election"}); }
        const control=Number(election.commissionControl||0);
        if (control>=70) { await client.query("ROLLBACK"); return out(res,409,{error:"commission_already_controlled"}); }
        const cost=Number(Math.max(0.25,Number(state.gdp||350)*0.00012).toFixed(2));
        if (Number(state.treasury||0)<cost) { await client.query("ROLLBACK"); return out(res,409,{error:"insufficient_campaign_funds",required:cost,available:state.treasury}); }
        state.treasury=Number((Number(state.treasury)-cost).toFixed(2));
        state.budgetBalance=Number((Number(state.budgetBalance||0)-cost).toFixed(2));
        state.corruption=clampNumber(Number(state.corruption||30)+6,0,100);
        state.stability=clampNumber(Number(state.stability||60)-3,0,100);
        state.approval=clampNumber(Number(state.approval||50)-1.5,0,100);
        election.commissionControl=Math.min(70,control+35);
        election.commissionCaptured=true;
        state.election=election;
        await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(state),game.id]);
        const headline="Влияние на Центральную избирательную комиссию усилено";
        const article="Администрация добилась контроля над частью руководства избирательной комиссии. Это повышает возможность административного вмешательства, но ослабляет доверие к институтам.";
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'institutional_crisis',$3,$4,3,$5::jsonb)",[game.id,game.game_date,headline,article,JSON.stringify({commissionControl:election.commissionControl,cost,corruption:6,stability:-3,approval:-1.5})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'election_commission_capture',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({control:election.commissionControl,cost})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,election,commissionControl:election.commissionControl,cost});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/election/dictatorship" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})}, election={...(state.election||{})};
        if (!["election_campaign","election"].includes(state.phase) || Number(election.commissionControl||0)<70) {
          await client.query("ROLLBACK");
          return out(res,409,{error:"commission_control_required"});
        }
        state.phase="government";
        state.dictatorship=true;
        state.regimeType="Авторитарная диктатура";
        state.nextElectionDate=null;
        state.approval=clampNumber(Number(state.approval||50)-12,0,100);
        state.stability=clampNumber(Number(state.stability||50)-8,0,100);
        state.corruption=clampNumber(Number(state.corruption||30)+12,0,100);
        state.democracyIndex=clampNumber(Number(state.democracyIndex??55)-35,0,100);
        election.lastResult="power_grab";
        election.ended=true;
        state.election=election;
        await client.query("UPDATE game_saves SET state=$1::jsonb,president_bio=$2,updated_at=now() WHERE id=$3",[JSON.stringify(state),"Глава государства. Установлен авторитарный режим; очередные конкурентные выборы отменены.",game.id]);
        const headline="Президент объявил чрезвычайную реорганизацию политической системы";
        const article="После установления контроля над Центральной избирательной комиссией президент сосредоточил власть в исполнительной вертикали. Конкурентные национальные выборы отменены. Международная легитимность и общественное доверие резко снизились.";
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'constitutional_crisis',$3,$4,4,$5::jsonb)",[game.id,game.game_date,headline,article,JSON.stringify({dictatorship:true,approval:-12,stability:-8,corruption:12})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'dictatorship_established',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({commissionControl:election.commissionControl})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,dictatorship:true,game:{id:game.id,state}});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/election/vote" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})}, election={...(state.election||{})};
        if (!["election_campaign","election"].includes(state.phase)) { await client.query("ROLLBACK"); return out(res,409,{error:"no_active_election"}); }
        if (Number(election.actionsRemaining||0)>0) { await client.query("ROLLBACK"); return out(res,409,{error:"campaign_actions_remaining",remaining:election.actionsRemaining}); }
        const noise=crypto.randomInt(-2,4);
        const voteShare=Number(clampNumber(Number(election.candidateSupport||35)+Number(election.commissionControl||0)*0.10+noise,5,95).toFixed(1));
        const won=voteShare>=50;
        const electionDate=election.scheduledDate || game.game_date;
        if (won) {
          state.phase="government";
          state.electionsWon=Number(state.electionsWon||0)+1;
          state.nextElectionDate=election.firstElection ? (Number(state.startYear||2026)+4)+"-01-01" : (() => { const d=new Date(String(electionDate).slice(0,10)+"T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear()+4); return d.toISOString().slice(0,10); })();
          state.approval=clampNumber(Number(state.approval||50)+4,0,100);
          election.lastResult="victory";
          election.voteShare=voteShare;
          election.oppositionShare=Number((100-voteShare).toFixed(1));
          election.ended=true;
        } else {
          election.lastResult="defeat";
          election.voteShare=voteShare;
          election.oppositionShare=Number((100-voteShare).toFixed(1));
          election.ended=true;
        }
        state.election=election;
        await client.query("UPDATE game_saves SET state=$1::jsonb,status=$2,updated_at=now() WHERE id=$3",[JSON.stringify(state),won?"active":"finished",game.id]);
        const headline=won?"Победа на национальных выборах":"Оппозиция победила на национальных выборах";
        const article=won
          ? "Партия "+(election.partyName||"президента")+" получила "+voteShare+"% голосов. Избирательная комиссия подтвердила победу. Президент получает мандат на следующий срок."
          : "Кандидат получил "+voteShare+"% голосов и уступил оппонентам. Правительство передаёт полномочия победившей политической силе. Кампания завершена.";
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'election_result',$3,$4,$5,$6::jsonb)",[game.id,electionDate,headline,article,won?1:3,JSON.stringify({won,voteShare,oppositionShare:100-voteShare})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'election_result',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({won,voteShare,commissionControl:election.commissionControl||0})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,won,voteShare,oppositionShare:100-voteShare,nextElectionDate:state.nextElectionDate||null});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/current" && req.method === "GET") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const result = await presidentialPool.query(
        "SELECT s.id,s.save_name,s.president_name,s.president_age,s.president_bio,s.game_date,s.turn_number,s.state,s.status,c.iso2,c.name_en,c.name_local,c.flag_emoji,c.government_type,c.region FROM game_saves s LEFT JOIN countries c ON c.id=s.country_id WHERE s.owner_user_id=$1 AND s.status='active' ORDER BY s.updated_at DESC LIMIT 1",
        [gameUser.telegram_id]
      );
      const game=result.rows[0] || null;
      if (!game) return out(res,200,{game:null,ministers:[],relations:[],units:[],events:[],decrees:[]});
      const [ministers,relations,units,events,decrees]=await Promise.all([
        presidentialPool.query("SELECT id,portfolio,full_name,age,competence,loyalty,approval,traits FROM ministers WHERE save_id=$1 AND dismissed_at IS NULL ORDER BY portfolio",[game.id]),
        presidentialPool.query("SELECT id,other_country_name,relation_score,status,treaties FROM diplomatic_relations WHERE save_id=$1 ORDER BY relation_score DESC",[game.id]),
        presidentialPool.query("SELECT id,unit_type,quantity,readiness,supply FROM military_units WHERE save_id=$1 ORDER BY unit_type",[game.id]),
        presidentialPool.query("SELECT id,game_date,event_type,headline,article,severity,effects FROM game_events WHERE save_id=$1 ORDER BY game_date DESC,created_at DESC LIMIT 12",[game.id]),
        presidentialPool.query("SELECT id,decree_number,title,summary,body,status,effects,created_at,published_at FROM decrees WHERE save_id=$1 ORDER BY decree_number DESC LIMIT 12",[game.id])
      ]);
      return out(res,200,{game,ministers:ministers.rows,relations:relations.rows,units:units.rows,events:events.rows,decrees:decrees.rows});
    }

    if (path === "/api/presidential/game/action" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req), action=txt(input.action,64);
      const policies = {
        public_health:{title:"Инвестиции в здравоохранение",cost:0.0016,event:"Правительство утвердило программу модернизации здравоохранения",article:"Началось финансирование медицинских учреждений и расширение доступа к базовым услугам.",effects:{healthcare:5,publicServices:1.5,approval:0.8,stability:0.4,gdpGrowth:0.03}},
        education:{title:"Реформа образования",cost:0.0014,event:"Утверждена национальная программа образования",article:"Средства направлены на школы, университеты и программы подготовки специалистов.",effects:{education:5,publicServices:1,approval:0.7,gdpGrowth:0.12,unemployment:-0.08}},
        infrastructure:{title:"Инфраструктурная программа",cost:0.0024,event:"Запущена программа развития инфраструктуры",article:"Правительство выделило финансирование на дороги, железнодорожные узлы и логистику.",effects:{infrastructure:5,gdpGrowth:0.2,approval:0.7,unemployment:-0.15}},
        tax_relief:{title:"Снижение налоговой нагрузки",cost:0.0012,event:"Президент подписал налоговую реформу",article:"Налоговая нагрузка для бизнеса снижена. Правительство рассчитывает на рост инвестиций и деловой активности.",effects:{taxRate:-1,gdpGrowth:0.2,approval:1.2,inflation:0.08}},
        anti_corruption:{title:"Антикоррупционная кампания",cost:0.0006,event:"Начата общенациональная антикоррупционная кампания",article:"Введены дополнительные проверки государственных закупок и новые механизмы общественного контроля.",effects:{corruption:-5,approval:1.5,stability:1.2,gdpGrowth:0.06}},
        defense:{title:"Модернизация вооружённых сил",cost:0.003,event:"Утверждён план модернизации вооружённых сил",article:"Дополнительные средства направлены на подготовку, техническое обслуживание и снабжение воинских подразделений.",effects:{militaryPower:3.5,stability:0.3,approval:0.2}}
      };
      const policy=policies[action];
      if (!policy) return out(res,400,{error:"unknown_policy"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})};
        if (state.phase && state.phase!=="government") { await client.query("ROLLBACK"); return out(res,409,{error:"election_campaign_in_progress"}); }
        const points=Number.isFinite(Number(state.actionPoints))?Number(state.actionPoints):2;
        if (points<1) { await client.query("ROLLBACK"); return out(res,409,{error:"no_action_points"}); }
        const cost=Number((Math.max(1,Number(state.gdp||350))*policy.cost).toFixed(2));
        const treasury=Number(state.treasury||0);
        if (treasury<cost) { await client.query("ROLLBACK"); return out(res,409,{error:"insufficient_treasury",required:cost,available:treasury}); }
        state.treasury=Number((treasury-cost).toFixed(2));
        state.budgetBalance=Number((Number(state.budgetBalance||0)-cost).toFixed(2));
        for (const [key,value] of Object.entries(policy.effects)) {
          const current=Number(state[key]||0);
          const bounds=key==="gdpGrowth"?[-20,30]:key==="inflation"?[0,200]:key==="unemployment"?[0,60]:key==="taxRate"?[0,70]:[0,100];
          state[key]=Number(clampNumber(current+value,bounds[0],bounds[1]).toFixed(2));
        }
        state.actionPoints=points-1;
        const updated=await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2 RETURNING id,state,game_date,turn_number",[JSON.stringify(state),game.id]);
        if (action==="defense") await client.query("UPDATE military_units SET readiness=LEAST(100,readiness+4),supply=LEAST(100,supply+3),updated_at=now() WHERE save_id=$1",[game.id]);
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'government_action',$3,$4,2,$5::jsonb)",[game.id,game.game_date,policy.event,policy.article,JSON.stringify({action,cost,effects:policy.effects})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'policy_action',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({action,cost,actionPoints:state.actionPoints})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,game:updated.rows[0],cost,actionPoints:state.actionPoints});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/advance" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})};
        if (state.phase && state.phase!=="government") { await client.query("ROLLBACK"); return out(res,409,{error:"election_campaign_in_progress"}); }
        const gdp=Math.max(1,Number(state.gdp||350));
        const previous={gdp:Number(state.gdp||350),gdpGrowth:Number(state.gdpGrowth||2),inflation:Number(state.inflation||3),unemployment:Number(state.unemployment||5),approval:Number(state.approval||50),stability:Number(state.stability||60),treasury:Number(state.treasury||0)};
        const infrastructure=Number(state.infrastructure||52), education=Number(state.education||55), corruption=Number(state.corruption||34);
        const ministers=await client.query("SELECT portfolio,competence,loyalty,traits FROM ministers WHERE save_id=$1 AND dismissed_at IS NULL",[game.id]);
        const ministerEffects={gdpGrowth:0,inflation:0,unemployment:0,approval:0,stability:0,corruption:0,publicServices:0,education:0,healthcare:0,infrastructure:0,militaryPower:0};
        for (const minister of ministers.rows) {
          const traits=minister.traits&&typeof minister.traits==="object"?minister.traits:{};
          const effects=traits.effects&&typeof traits.effects==="object"?traits.effects:{};
          const competenceFactor=0.45+Number(minister.competence||50)/100;
          const loyaltyFactor=Number(minister.loyalty||50)<25?0.45:1;
          for (const [key,value] of Object.entries(effects)) {
            if (Object.prototype.hasOwnProperty.call(ministerEffects,key) && Number.isFinite(Number(value))) {
              ministerEffects[key]+=Number(value)*competenceFactor*loyaltyFactor;
            }
          }
          if (Number(minister.loyalty||50)<25) {
            ministerEffects.corruption+=0.12;
            ministerEffects.stability-=0.10;
          }
        }
        const randomEvents=[
          {type:"economy",headline:"Иностранные инвесторы расширяют присутствие",article:"Несколько международных компаний объявили о новых вложениях в экономику страны. Министерство экономики ожидает дополнительные рабочие места.",approval:1.2,stability:0.2,growth:0.15,treasury:0.55,inflation:0.02},
          {type:"society",headline:"Профсоюзы требуют повышения доходов",article:"Крупные профсоюзные объединения провели переговоры с правительством. Кабинету министров предстоит найти баланс между зарплатами и инфляцией.",approval:-1.4,stability:-0.5,growth:0,treasury:-0.15,inflation:0.08},
          {type:"economy",headline:"Центральный банк сохранил ключевую ставку",article:"Регулятор решил не менять денежно-кредитную политику и продолжить наблюдение за инфляционными рисками.",approval:0.2,stability:0.4,growth:0.02,treasury:0,inflation:-0.08},
          {type:"politics",headline:"Оппозиция потребовала парламентских слушаний",article:"Крупнейшие оппозиционные фракции потребовали отчёта правительства. Кабинету предстоит публично объяснить результаты реформ.",approval:-0.8,stability:-0.4,growth:0,treasury:0,inflation:0},
          {type:"diplomacy",headline:"Партнёры предложили расширить торговлю",article:"Дипломатические каналы передали предложение о расширении экономического сотрудничества. Министерство иностранных дел готовит переговорную позицию.",approval:0.5,stability:0.3,growth:0.12,treasury:0.25,inflation:0},
          {type:"society",headline:"Правительство получило поддержку общественных организаций",article:"Общественные организации положительно оценили последние государственные программы и предложили совместные социальные проекты.",approval:1.1,stability:0.6,growth:0.02,treasury:-0.08,inflation:0},
          {type:"crisis",headline:"Погодные условия осложнили работу инфраструктуры",article:"Неблагоприятная погода привела к локальным перебоям в транспортной системе. Региональным властям поручено восстановить движение.",approval:-0.6,stability:-0.2,growth:-0.08,treasury:-0.35,inflation:0.05},
          {type:"politics",headline:"Аудит выявил нарушения в закупках",article:"Контрольные органы сообщили о нарушениях в нескольких государственных контрактах. Начата проверка, профильному министерству поручено представить предложения.",approval:corruption>40?-1.8:0.5,stability:-0.2,growth:-0.03,treasury:-0.1,inflation:0}
        ];
        const event=randomEvents[crypto.randomInt(randomEvents.length)];
        state.gdpGrowth=clampNumber(Number(state.gdpGrowth||0)+(infrastructure-50)*0.004+(education-50)*0.002-(corruption-30)*0.001+ministerEffects.gdpGrowth+event.growth,-15,20);
        const monthlyBalance=Number((gdp*((Number(state.taxRate||22)-21.5)/100/12)).toFixed(2));
        state.treasury=Number(Math.max(0,Number(state.treasury||0)+monthlyBalance+event.treasury+ministerEffects.budgetBalance*0.05).toFixed(2));
        state.budgetBalance=monthlyBalance;
        state.debt=Number(clampNumber(Number(state.debt||0)+(monthlyBalance<0?Math.abs(monthlyBalance)/gdp*100:0),0,500).toFixed(2));
        state.gdp=Number((gdp*(1+state.gdpGrowth/1200)).toFixed(2));
        state.inflation=Number(clampNumber(Number(state.inflation||3)+event.inflation+(state.gdpGrowth>5?0.07:-0.02)+(Math.random()-0.5)*0.12+ministerEffects.inflation,0,100).toFixed(2));
        state.unemployment=Number(clampNumber(Number(state.unemployment||5)-state.gdpGrowth*0.025+0.025+(Math.random()-0.5)*0.18+ministerEffects.unemployment,0,60).toFixed(2));
        state.approval=Number(clampNumber(Number(state.approval||50)+event.approval+(state.gdpGrowth-2)*0.16-(state.inflation-3)*0.045-(state.unemployment-5)*0.10+(Number(state.publicServices||58)-55)*0.045+ministerEffects.approval,0,100).toFixed(2));
        state.stability=Number(clampNumber(Number(state.stability||60)+event.stability+(state.approval-50)*0.025-(corruption-35)*0.018+ministerEffects.stability,0,100).toFixed(2));
        for (const key of ["publicServices","education","healthcare","infrastructure","militaryPower"]) {
          if (ministerEffects[key]) state[key]=Number(clampNumber(Number(state[key]||50)+ministerEffects[key],0,100).toFixed(2));
        }
        state.corruption=Number(clampNumber(Number(state.corruption||30)+ministerEffects.corruption,0,100).toFixed(2));
        state.actionPoints=2;
        const updated=await client.query("UPDATE game_saves SET state=$1::jsonb,turn_number=turn_number+1,game_date=game_date+interval '1 month',updated_at=now() WHERE id=$2 RETURNING id,game_date,turn_number,state",[JSON.stringify(state),game.id]);
        const newDate=String(updated.rows[0].game_date).slice(0,10);
        let electionStarted=false;
        if (!state.dictatorship && state.nextElectionDate) {
          const triggerDate=new Date(String(state.nextElectionDate).slice(0,10)+"T00:00:00Z");
          triggerDate.setUTCMonth(triggerDate.getUTCMonth()-3);
          if (new Date(newDate+"T00:00:00Z")>=triggerDate) {
            const support=clampNumber(34+(Number(state.approval||50)-50)*0.32+(Number(state.stability||60)-60)*0.08+(Number(state.gdpGrowth||2)-2)*0.6-(Number(state.inflation||3)-3)*0.04-(Number(state.unemployment||5)-5)*0.12,18,55);
            state.phase="election";
            state.election={
              kind:state.election&&state.election.kind||"presidential",
              type:state.election&&state.election.type||"Национальные выборы",
              partyName:state.election&&state.election.partyName||"Партия национального развития",
              candidateSupport:Number(support.toFixed(1)),oppositionSupport:Number((100-support).toFixed(1)),
              actionsRemaining:4,actionsTaken:[],commissionControl:0,
              scheduledDate:state.nextElectionDate,firstElection:false,round:Number(state.electionsWon||1)+1
            };
            electionStarted=true;
          }
        }
        state.lastMonthChanges={
          gdp:Number((state.gdp-previous.gdp).toFixed(2)),
          gdpGrowth:Number((state.gdpGrowth-previous.gdpGrowth).toFixed(2)),
          inflation:Number((state.inflation-previous.inflation).toFixed(2)),
          unemployment:Number((state.unemployment-previous.unemployment).toFixed(2)),
          approval:Number((state.approval-previous.approval).toFixed(2)),
          stability:Number((state.stability-previous.stability).toFixed(2)),
          treasury:Number((state.treasury-previous.treasury).toFixed(2)),
          ministerEffects
        };
        await client.query("UPDATE game_saves SET state=$1::jsonb WHERE id=$2",[JSON.stringify(state),game.id]);
        const eventHeadline=electionStarted?"До национальных выборов осталось три месяца":event.headline;
        const eventArticle=electionStarted?"Началась предвыборная кампания. Правительству предстоит вновь получить мандат избирателей.":event.article;
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",[game.id,newDate,electionStarted?"election_notice":event.type,eventHeadline,eventArticle,electionStarted?2:(event.type==="crisis"?3:2),JSON.stringify({approval:event.approval,stability:event.stability,gdpGrowth:event.growth,treasury:event.treasury,monthlyBudget:monthlyBalance,ministerEffects,electionStarted})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'month_advanced',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({turn:updated.rows[0].turn_number,event:event.type,monthlyBudget:monthlyBalance,electionStarted,ministerEffects})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,game:{...updated.rows[0],state},event:{type:electionStarted?"election_notice":event.type,headline:eventHeadline,article:eventArticle},monthlyBudget:monthlyBalance,electionStarted,ministerEffects,lastMonthChanges:state.lastMonthChanges});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/minister" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req), action=txt(input.action,32);
      const portfolios=["Финансы","Иностранные дела","Оборона","Экономика","Здравоохранение","Образование","Внутренние дела"];
      const archetypes={
        technocrat:{label:"Технократ",effects:{gdpGrowth:0.08,inflation:-0.025}},
        reformer:{label:"Реформатор",effects:{publicServices:0.13,approval:0.11,stability:-0.03}},
        diplomat:{label:"Дипломат",effects:{stability:0.07,approval:0.06}},
        hardliner:{label:"Силовик",effects:{stability:0.15,approval:-0.08,corruption:0.04}},
        populist:{label:"Популист",effects:{approval:0.24,stability:-0.06,budgetBalance:-0.08}},
        oligarch:{label:"Связи с бизнесом",effects:{gdpGrowth:0.12,corruption:0.18,approval:-0.10}},
        incompetent:{label:"Некомпетентный",effects:{gdpGrowth:-0.10,corruption:0.14,stability:-0.06}}
      };
      const portfolioEffects={
        "Финансы":{inflation:-0.04,budgetBalance:0.04},
        "Иностранные дела":{gdpGrowth:0.03,stability:0.03},
        "Оборона":{militaryPower:0.16,stability:0.08},
        "Экономика":{gdpGrowth:0.11,unemployment:-0.05},
        "Здравоохранение":{healthcare:0.18,approval:0.08},
        "Образование":{education:0.16,gdpGrowth:0.03},
        "Внутренние дела":{stability:0.10,corruption:-0.08}
      };
      if (!["appoint","dismiss"].includes(action)) return out(res,400,{error:"invalid_minister_action"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})};
        if (state.phase && state.phase!=="government") { await client.query("ROLLBACK"); return out(res,409,{error:"election_campaign_in_progress"}); }
        let headline,article,minister;
        if (action==="appoint") {
          const name=txt(input.name,100), portfolio=txt(input.portfolio,80), age=Number(input.age);
          const competence=Number(input.competence), loyalty=Number(input.loyalty);
          const archetype=txt(input.archetype,32), portraitId=txt(input.portraitId,4);
          if (name.length<3||!portfolios.includes(portfolio)||!Number.isInteger(age)||age<25||age>90||
              !Number.isInteger(competence)||competence<20||competence>100||!Number.isInteger(loyalty)||loyalty<20||loyalty>100||
              !archetypes[archetype]||!/^p(0[1-9]|1[0-6])$/.test(portraitId)) {
            await client.query("ROLLBACK");
            return out(res,400,{error:"invalid_minister_details"});
          }
          const occupied=await client.query("SELECT id FROM ministers WHERE save_id=$1 AND portfolio=$2 AND dismissed_at IS NULL",[game.id,portfolio]);
          if (occupied.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"portfolio_already_filled"}); }
          const effects={...portfolioEffects[portfolio],...archetypes[archetype].effects};
          for (const key of Object.keys(effects)) {
            if (portfolioEffects[portfolio]&&Object.prototype.hasOwnProperty.call(portfolioEffects[portfolio],key)&&archetypes[archetype].effects[key]!==undefined) {
              effects[key]=Number((portfolioEffects[portfolio][key]+archetypes[archetype].effects[key]).toFixed(3));
            }
          }
          const traits={portraitId,archetype,archetypeLabel:archetypes[archetype].label,effects};
          const inserted=await client.query(
            "INSERT INTO ministers(save_id,portfolio,full_name,age,competence,loyalty,approval,traits) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id,portfolio,full_name,age,competence,loyalty,approval,traits",
            [game.id,portfolio,name,age,competence,loyalty,crypto.randomInt(42,81),JSON.stringify(traits)]
          );
          minister=inserted.rows[0];
          state.stability=clampNumber(Number(state.stability||50)+(loyalty-50)*0.012,0,100);
          headline="Президент назначил нового министра";
          article=name+" возглавил(а) направление «"+portfolio+"». Специализация: "+archetypes[archetype].label+". Компетентность: "+competence+"/100, лояльность: "+loyalty+"/100.";
        } else {
          const ministerId=txt(input.ministerId,64);
          if (!/^[0-9a-f-]{36}$/i.test(ministerId)) { await client.query("ROLLBACK"); return out(res,400,{error:"invalid_minister_id"}); }
          const removed=await client.query("UPDATE ministers SET dismissed_at=now() WHERE id=$1 AND save_id=$2 AND dismissed_at IS NULL RETURNING id,portfolio,full_name,loyalty",[ministerId,game.id]);
          if (!removed.rowCount) { await client.query("ROLLBACK"); return out(res,404,{error:"minister_not_found"}); }
          minister=removed.rows[0];
          state.stability=clampNumber(Number(state.stability||50)-0.35,0,100);
          state.approval=clampNumber(Number(state.approval||50)+(Number(minister.loyalty)<40?0.4:-0.2),0,100);
          headline="В правительстве произошла отставка";
          article=minister.full_name+" покинул(а) пост министра («"+minister.portfolio+"»). Президенту предстоит назначить нового руководителя.";
        }
        await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(state),game.id]);
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'government',$3,$4,2,$5::jsonb)",[game.id,game.game_date,headline,article,JSON.stringify({action,minister:minister.id})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,$3,$4::jsonb)",[gameUser.id,game.id,"minister_"+action,JSON.stringify({ministerId:minister.id,portfolio:minister.portfolio})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,minister});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/diplomacy" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req), action=txt(input.action,32), relationId=txt(input.relationId,64);
      const operations={
        summit:{score:12,cost:0.08,growth:0.02,approval:0.35,headline:"Проведён дипломатический саммит",verb:"Стороны договорились продолжить политический диалог и укрепить двусторонние контакты."},
        trade:{score:9,cost:0.15,growth:0.12,approval:0.2,headline:"Начаты переговоры о торговом соглашении",verb:"Стороны обсудили снижение торговых барьеров и расширение экономического сотрудничества."},
        sanctions:{score:-18,cost:0.04,growth:-0.08,approval:-0.3,headline:"Правительство объявило о введении ограничительных мер",verb:"Дипломатические отношения осложнились. Министерства оценивают возможные ответные шаги."}
      };
      const operation=operations[action];
      if (!operation||!/^[0-9a-f-]{36}$/i.test(relationId)) return out(res,400,{error:"invalid_diplomatic_action"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0], state={...(game.state||{})}, points=Number.isFinite(Number(state.actionPoints))?Number(state.actionPoints):2;
        if (points<1) { await client.query("ROLLBACK"); return out(res,409,{error:"no_action_points"}); }
        const relationResult=await client.query("SELECT * FROM diplomatic_relations WHERE id=$1 AND save_id=$2 FOR UPDATE",[relationId,game.id]);
        if (!relationResult.rowCount) { await client.query("ROLLBACK"); return out(res,404,{error:"diplomatic_relation_not_found"}); }
        const relation=relationResult.rows[0], score=clampNumber(Number(relation.relation_score)+operation.score,-100,100);
        const status=score>=50?"allied":score<=-45?"hostile":"neutral";
        const updatedRelation=await client.query("UPDATE diplomatic_relations SET relation_score=$1,status=$2,updated_at=now() WHERE id=$3 RETURNING id,other_country_name,relation_score,status,treaties",[score,status,relationId]);
        const cost=operation.cost;
        state.treasury=Number(Math.max(0,Number(state.treasury||0)-cost).toFixed(2));
        state.budgetBalance=Number((Number(state.budgetBalance||0)-cost).toFixed(2));
        state.gdpGrowth=clampNumber(Number(state.gdpGrowth||0)+operation.growth,-20,30);
        state.approval=clampNumber(Number(state.approval||50)+operation.approval,0,100);
        state.actionPoints=points-1;
        await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(state),game.id]);
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'diplomacy',$3,$4,2,$5::jsonb)",[game.id,game.game_date,operation.headline,relation.other_country_name+": "+operation.verb,JSON.stringify({action,country:relation.other_country_name,relationScore:score,cost})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'diplomatic_action',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({action,country:relation.other_country_name,relationScore:score})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,relation:updatedRelation.rows[0],actionPoints:state.actionPoints});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/decree/draft" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req), order=txt(input.order,5000);
      if (order.length<10) return out(res,400,{error:"initiative_too_short"});
      const found=await presidentialPool.query("SELECT s.*,c.name_local,c.name_en FROM game_saves s LEFT JOIN countries c ON c.id=s.country_id WHERE s.owner_user_id=$1 AND s.status='active' ORDER BY s.updated_at DESC LIMIT 1",[gameUser.telegram_id]);
      if (!found.rowCount) return out(res,409,{error:"start_a_game_first"});
      const game=found.rows[0];
      if ((game.state||{}).phase && (game.state||{}).phase!=="government") return out(res,409,{error:"election_campaign_in_progress"});
      const effects=assessPolicy(order,game.state||{}), document=await draftOfficialDocument(order,game,effects);
      const numberResult=await presidentialPool.query("SELECT COALESCE(MAX(decree_number),0)+1 AS next_number FROM decrees WHERE save_id=$1",[game.id]);
      const inserted=await presidentialPool.query(
        "INSERT INTO decrees(save_id,decree_number,title,summary,body,original_order,status,effects) VALUES($1,$2,$3,$4,$5,$6,'draft',$7::jsonb) RETURNING id,decree_number,title,summary,body,status,effects,created_at",
        [game.id,numberResult.rows[0].next_number,document.title,document.summary,document.body,order,JSON.stringify({preview:effects})]
      );
      return out(res,201,{decree:inserted.rows[0]});
    }

    if (path === "/api/presidential/game/decree/publish" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req), decreeId=txt(input.decreeId,64);
      if (!/^[0-9a-f-]{36}$/i.test(decreeId)) return out(res,400,{error:"invalid_decree_id"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT s.* FROM game_saves s WHERE s.owner_user_id=$1 AND s.status='active' ORDER BY s.updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0];
        if ((game.state||{}).phase && (game.state||{}).phase!=="government") { await client.query("ROLLBACK"); return out(res,409,{error:"election_campaign_in_progress"}); }
        const d=await client.query("SELECT * FROM decrees WHERE id=$1 AND save_id=$2 FOR UPDATE",[decreeId,game.id]);
        if (!d.rowCount) { await client.query("ROLLBACK"); return out(res,404,{error:"decree_not_found"}); }
        if (d.rows[0].status!=="draft") { await client.query("ROLLBACK"); return out(res,409,{error:"decree_not_draft"}); }
        const state={...(game.state||{})};
        const actionPoints=Number.isFinite(Number(state.actionPoints))?Number(state.actionPoints):2;
        if (actionPoints<1) { await client.query("ROLLBACK"); return out(res,409,{error:"no_action_points"}); }
        const effects=assessPolicy(d.rows[0].original_order,state);
        state.actionPoints=actionPoints-1;
        state.treasury=Number((Number(state.treasury||0)-effects.budgetCost+effects.budgetRevenue).toFixed(2));
        state.budgetBalance=Number((Number(state.budgetBalance||0)-effects.budgetCost+effects.budgetRevenue).toFixed(2));
        state.debt=clampNumber(Number(state.debt||0)+(effects.budgetCost/Math.max(1,Number(state.gdp||1)))*100,0,500);
        state.approval=clampNumber(Number(state.approval||50)+effects.approval,0,100);
        state.stability=clampNumber(Number(state.stability||50)+effects.stability,0,100);
        state.gdpGrowth=clampNumber(Number(state.gdpGrowth||0)+effects.gdpGrowth,-20,30);
        state.inflation=clampNumber(Number(state.inflation||0)+effects.inflation,0,200);
        state.unemployment=clampNumber(Number(state.unemployment||0)+effects.unemployment,0,60);
        state.publicServices=clampNumber(Number(state.publicServices||0)+effects.publicServices,0,100);
        state.militaryPower=clampNumber(Number(state.militaryPower||0)+effects.militaryPower,0,100);
        state.corruption=clampNumber(Number(state.corruption||0)+effects.corruption,0,100);
        state.taxRate=clampNumber(Number(state.taxRate||0)+effects.taxRate,0,70);
        state.gdp=Number((Number(state.gdp||0)*(1+Number(state.gdpGrowth||0)/1200)).toFixed(2));
        const updated=await client.query(
          "UPDATE game_saves SET state=$1::jsonb,turn_number=turn_number+1,game_date=game_date+interval '1 month',updated_at=now() WHERE id=$2 RETURNING id,game_date,turn_number,state",
          [JSON.stringify(state),game.id]
        );
        await client.query("UPDATE decrees SET status='published',effects=$1::jsonb,published_at=now() WHERE id=$2",[JSON.stringify(effects),decreeId]);
        await client.query(
          "INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'decree',$3,$4,2,$5::jsonb)",
          [game.id,updated.rows[0].game_date,d.rows[0].title,d.rows[0].summary+" "+d.rows[0].body.slice(0,900),JSON.stringify(effects)]
        );
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'decree_published',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({decreeId,decreeNumber:d.rows[0].decree_number,effects})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,game:updated.rows[0],effects});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }

    if (path === "/api/presidential/game/new" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input = await readBody(req);
      const countryId = Number(input.countryId);
      const president = txt(input.presidentName,100);
      const age = Number(input.presidentAge);
      const course = txt(input.politicalCourse,40);
      const difficulty = txt(input.difficulty,20);
      const startYear = Number(input.startYear);
      const portraitId = txt(input.portraitId,4);
      const courseOptions = {
        social_democracy:{label:"Социальная демократия",effects:{publicServices:7,education:4,healthcare:5,gdpGrowth:-0.1,approval:2,treasury:-2}},
        market_liberal:{label:"Рыночный либерализм",effects:{gdpGrowth:0.7,taxRate:-2,unemployment:-0.3,approval:1,publicServices:-2,stability:-1}},
        conservative:{label:"Консервативный курс",effects:{stability:6,militaryPower:5,taxRate:1,approval:1}},
        green_transition:{label:"Зелёная модернизация",effects:{infrastructure:4,healthcare:2,gdpGrowth:-0.2,corruption:-1}},
        industrial:{label:"Промышленное развитие",effects:{gdpGrowth:0.6,infrastructure:5,militaryPower:2,treasury:-3}}
      };
      const difficultyOptions = {
        easy:{label:"Облегчённая",treasury:1.25,approval:8,stability:7,debt:-5},
        normal:{label:"Стандартная",treasury:1,approval:0,stability:0,debt:0},
        hard:{label:"Сложная",treasury:0.72,approval:-9,stability:-12,debt:12}
      };
      if (!Number.isSafeInteger(countryId) || president.length < 3 || !Number.isInteger(age) || age < 25 || age > 90 ||
          !courseOptions[course] || !difficultyOptions[difficulty] || !Number.isInteger(startYear) || startYear < 2026 || startYear > 2030 ||
          !/^p(0[1-9]|1[0-6])$/.test(portraitId)) {
        return out(res,400,{error:"invalid_campaign_setup"});
      }
      const countryResult = await presidentialPool.query("SELECT * FROM countries WHERE id=$1 AND iso2 IS NOT NULL",[countryId]);
      if (!countryResult.rowCount) return out(res,404,{error:"country_not_found"});
      const country = countryResult.rows[0];
      const baseline = country.baseline_state || {};
      const base = (key,fallback) => Number.isFinite(Number(baseline[key])) ? Number(baseline[key]) : fallback;
      const state = {
        gdp:base("gdp",350),gdpGrowth:base("gdpGrowth",2.1),inflation:base("inflation",3.2),
        unemployment:base("unemployment",5.4),approval:base("approval",54),stability:base("stability",65),
        budgetBalance:base("budgetBalance",0),treasury:base("treasury",30),population:base("population",25),
        militaryPower:base("militaryPower",48),publicServices:base("publicServices",55),corruption:base("corruption",34),
        debt:base("debt",55),taxRate:base("taxRate",22),education:base("education",55),
        healthcare:base("healthcare",58),infrastructure:base("infrastructure",52),actionPoints:2,
        politicalCourse:course,difficulty:difficulty,presidentPortrait:portraitId,startYear:startYear,
        phase:"election_campaign",dictatorship:false,electionsWon:0,nextElectionDate:null,
        democracyIndex:55,
        election:{
          kind:/парламент|монарх/i.test(String(country.government_type||""))?"parliamentary":"presidential",
          type:/парламент|монарх/i.test(String(country.government_type||""))?"Парламентские выборы":"Президентские выборы",
          partyName:txt(input.partyName,80)||"Партия национального развития",
          candidateSupport:Number(clampNumber(37+(course==="social_democracy"?2:course==="conservative"?1:0)+(difficulty==="easy"?4:difficulty==="hard"?-5:0),22,52).toFixed(1)),
          oppositionSupport:45,actionsRemaining:4,actionsTaken:[],commissionControl:0,
          scheduledDate:yearDate,firstElection:true,round:1
        }
      };
      const effectBounds = key => key==="gdpGrowth"?[-20,30]:key==="inflation"?[0,200]:key==="unemployment"?[0,60]:key==="taxRate"?[0,70]:[0,100];
      for (const [key,value] of Object.entries(courseOptions[course].effects)) {
        const bounds = effectBounds(key);
        state[key] = Number(clampNumber(Number(state[key] || 0) + value,bounds[0],bounds[1]).toFixed(2));
      }
      const difficultyRule = difficultyOptions[difficulty];
      state.treasury = Number((state.treasury * difficultyRule.treasury).toFixed(2));
      state.approval = Number(clampNumber(state.approval + difficultyRule.approval,0,100).toFixed(2));
      state.stability = Number(clampNumber(state.stability + difficultyRule.stability,0,100).toFixed(2));
      state.debt = Number(clampNumber(state.debt + difficultyRule.debt,0,500).toFixed(2));
      const campaignTitle = txt(input.campaignTitle,90) || country.name_local || country.name_en;
      const bio = "Кандидат на общенациональных выборах. Политический курс: " + courseOptions[course].label + ". Сложность: " + difficultyRule.label + ".";
      const yearDate = String(startYear) + "-01-01";
      const cabinetPools = {
        AR:["Lucía Fernández","Mateo González","Valentina Rodríguez","Santiago López","Camila Martínez"],
        AU:["Olivia Williams","Jack Thompson","Charlotte Wilson","Noah Harris","Amelia Martin"],
        BR:["Mariana Oliveira","Gabriel Souza","Beatriz Costa","Lucas Pereira","Isabela Santos"],
        CA:["Émilie Tremblay","Liam Anderson","Ava Campbell","Noah Martin","Chloé Gagnon"],
        CL:["Martina Rojas","Benjamín Muñoz","Isidora Silva","Vicente Torres","Florencia Soto"],
        EG:["Mariam Hassan","Omar Ahmed","Nour Ibrahim","Youssef Ali","Salma Mahmoud"],
        FR:["Camille Moreau","Gabriel Laurent","Léa Bernard","Hugo Petit","Inès Dubois"],
        DE:["Lena Schneider","Felix Weber","Mia Fischer","Leon Wagner","Clara Becker"],
        IN:["Aarav Sharma","Ananya Patel","Vivaan Singh","Aadhya Gupta","Ishaan Kumar"],
        ID:["Putri Wijaya","Budi Santoso","Siti Lestari","Rizky Pratama","Dewi Anggraini"],
        JP:["Haruto Sato","Yui Suzuki","Ren Tanaka","Hina Watanabe","Sota Ito"],
        KE:["Amina Otieno","Brian Mwangi","Wanjiku Njoroge","Daniel Kiptoo","Nia Kamau"],
        MX:["Sofía Hernández","Mateo García","Valentina López","Santiago Martínez","Camila Pérez"],
        NL:["Sophie de Vries","Daan Jansen","Emma van Dijk","Lucas Bakker","Lotte Visser"],
        NO:["Ingrid Hansen","Magnus Johansen","Nora Olsen","Emil Larsen","Sigrid Berg"],
        PL:["Anna Zielińska","Jakub Nowak","Zofia Wiśniewska","Antoni Kowalski","Maja Wójcik"],
        ZA:["Naledi Nkosi","Thabo Dlamini","Amahle Mokoena","Lethabo Ndlovu","Sipho Khumalo"],
        TH:["Nattaya Chaiyaporn","Thanakorn Srisai","Kanya Phrom","Preecha Boonmee","Suda Rattanakul"],
        TR:["Elif Yılmaz","Emir Demir","Zeynep Kaya","Kerem Şahin","Aylin Çelik"],
        UA:["Олена Ковальчук","Андрій Мельник","Марія Шевченко","Максим Бондаренко","Софія Ткаченко"]
      };
      const ministerNames = cabinetPools[country.iso2] || ["Alex Morgan","Maya Patel","Daniel Novak","Sofia Martin","Noah Chen"];
      const portfolios = ["Финансы","Иностранные дела","Оборона","Экономика","Здравоохранение"];
      const client = await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("UPDATE game_saves SET status='finished',updated_at=now() WHERE owner_user_id=$1 AND status='active'",[gameUser.telegram_id]);
        const saveResult = await client.query(
          "INSERT INTO game_saves(owner_user_id,save_name,country_id,president_name,president_age,president_bio,game_date,turn_number,state,status) VALUES($1,$2,$3,$4,$5,$6,$7::date,1,$8::jsonb,'active') RETURNING id,save_name,president_name,president_age,president_bio,game_date,turn_number,state,status",
          [gameUser.telegram_id,campaignTitle,country.id,president,age,bio,yearDate,JSON.stringify(state)]
        );
        const save = saveResult.rows[0];
        const initialArchetypes=["technocrat","diplomat","hardliner","reformer","reformer"];
        const initialPortraits=["p03","p08","p11","p05","p14"];
        for (let i=0;i<portfolios.length;i++) {
          const competence=crypto.randomInt(55,86), loyalty=crypto.randomInt(48,89);
          const portfolioEffects={
            "Финансы":{inflation:-0.04,budgetBalance:0.04},
            "Иностранные дела":{gdpGrowth:0.03,stability:0.03},
            "Оборона":{militaryPower:0.16,stability:0.08},
            "Экономика":{gdpGrowth:0.11,unemployment:-0.05},
            "Здравоохранение":{healthcare:0.18,approval:0.08}
          }[portfolios[i]]||{};
          const profileEffects={
            technocrat:{gdpGrowth:0.08,inflation:-0.025},
            diplomat:{stability:0.07,approval:0.06},
            hardliner:{stability:0.15,approval:-0.08,corruption:0.04},
            reformer:{publicServices:0.13,approval:0.11,stability:-0.03}
          }[initialArchetypes[i]];
          const effects={...portfolioEffects};
          for (const [key,value] of Object.entries(profileEffects)) effects[key]=Number(((effects[key]||0)+value).toFixed(3));
          const traits={portraitId:initialPortraits[i],archetype:initialArchetypes[i],archetypeLabel:({technocrat:"Технократ",diplomat:"Дипломат",hardliner:"Силовик",reformer:"Реформатор"})[initialArchetypes[i]],effects};
          await client.query(
            "INSERT INTO ministers(save_id,portfolio,full_name,age,competence,loyalty,approval,traits) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
            [save.id,portfolios[i],ministerNames[i],crypto.randomInt(38,61),competence,loyalty,crypto.randomInt(42,72),JSON.stringify(traits)]
          );
        }
        const neighbours = await client.query(
          "SELECT name_local,name_en FROM countries WHERE id<>$1 ORDER BY CASE WHEN region=$2 THEN 0 ELSE 1 END,name_en LIMIT 4",
          [country.id,country.region]
        );
        for (const n of neighbours.rows) {
          await client.query(
            "INSERT INTO diplomatic_relations(save_id,other_country_name,relation_score,status,treaties) VALUES($1,$2,0,'neutral','[]'::jsonb)",
            [save.id,n.name_local || n.name_en]
          );
        }
        const population = Number(state.population || 25);
        const militaryUnits = [
          ["Сухопутные войска",Math.max(8000,Math.round(population*2800)),67,72],
          ["Военно-воздушные силы",Math.max(35,Math.round(Number(state.militaryPower||40)*2.4)),70,76],
          ["Военно-морские силы",Math.max(3,Math.round(population*0.55)),64,69],
          ["Национальная гвардия",Math.max(2500,Math.round(population*800)),68,74]
        ];
        for (const unit of militaryUnits) {
          await client.query(
            "INSERT INTO military_units(save_id,unit_type,quantity,readiness,supply) VALUES($1,$2,$3,$4,$5)",
            [save.id,unit[0],unit[1],unit[2],unit[3]]
          );
        }
        const startArticle = "В " + (country.name_local || country.name_en) + " состоялась церемония вступления в должность президента " + president + ". Новая администрация начинает работу с курсом «" + courseOptions[course].label + "». Стартовые условия: " + difficultyRule.label.toLowerCase() + ".";
        await client.query(
          "INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'inauguration',$3,$4,2,'{}'::jsonb)",
          [save.id,yearDate,"Президент " + president + " вступил в должность",startArticle]
        );
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'campaign_created',$3::jsonb)",[
          gameUser.id,save.id,JSON.stringify({countryId:country.id,iso2:country.iso2,course,difficulty,startYear,portraitId})
        ]);
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
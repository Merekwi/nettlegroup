import { Hono } from "hono";
import { Pool } from "pg";
import { attachDatabasePool } from "@neon/functions";
import { createHmac, timingSafeEqual, randomBytes, createHash } from "node:crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);

const app = new Hono();
const siteOrigin = process.env.SITE_ORIGIN || "https://www.nettlegroup.space";
const cookieName = "nettle_session";
const ttlSeconds = 60 * 60 * 24 * 7;

function cors(c: any) {
  const origin = c.req.header("origin");
  if (origin === siteOrigin) {
    c.header("Access-Control-Allow-Origin", siteOrigin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    c.header("Vary", "Origin");
  }
}
app.use("*", async (c, next) => { cors(c); if (c.req.method === "OPTIONS") return c.body(null, 204); await next(); });
app.use("/api/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.header("origin") !== siteOrigin) return c.json({error:"origin_check_failed"},403);
  await next();
});

function sign(value: string) {
  return createHmac("sha256", process.env.SESSION_SECRET!).update(value).digest("hex");
}
function issueSession(userId: string, telegramId: string) {
  const payload = Buffer.from(JSON.stringify({userId, telegramId, exp: Math.floor(Date.now()/1000)+ttlSeconds})).toString("base64url");
  return payload + "." + sign(payload);
}
function readSession(raw?: string) {
  if (!raw) return null;
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a,b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    if (!data.exp || data.exp < Math.floor(Date.now()/1000)) return null;
    return data as {userId:string;telegramId:string;exp:number};
  } catch { return null; }
}
async function currentUser(c: any) {
  const raw = c.req.header("cookie")?.split(";").map((x:string)=>x.trim()).find((x:string)=>x.startsWith(cookieName+"="))?.slice(cookieName.length+1);
  const session = readSession(raw ? decodeURIComponent(raw) : undefined);
  if (!session) return null;
  const r = await pool.query("SELECT id,telegram_id,display_name,is_admin FROM public.user_profiles WHERE id=$1 AND telegram_id=$2",[session.userId,session.telegramId]);
  return r.rows[0] || null;
}
function verifyTelegram(data: Record<string,string>) {
  const hash = data.hash;
  if (!hash || !process.env.TELEGRAM_BOT_TOKEN) return null;
  const authDate = Number(data.auth_date);
  if (!Number.isFinite(authDate) || Math.floor(Date.now()/1000)-authDate > 600 || authDate > Math.floor(Date.now()/1000)+30) return null;
  const check = Object.keys(data).filter(k=>k!=="hash").sort().map(k=>k+"="+data[k]).join("\n");
  const secret = createHash("sha256").update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const expected = createHmac("sha256",secret).update(check).digest("hex");
  try { if (!timingSafeEqual(Buffer.from(hash,"hex"),Buffer.from(expected,"hex"))) return null; } catch { return null; }
  if (!data.id || !/^\d+$/.test(data.id)) return null;
  return {id:data.id, name:[data.first_name,data.last_name].filter(Boolean).join(" ").slice(0,160) || ("Telegram "+data.id)};
}
function sessionCookie(token: string) {
  return cookieName+"="+encodeURIComponent(token)+"; Path=/; HttpOnly; Secure; SameSite=None; Max-Age="+ttlSeconds+"; Domain=.nettlegroup.space";
}
app.get("/api/health", (c) => c.json({ok:true,service:"nettleapi"}));
app.get("/api/session", async (c) => {
  const u=await currentUser(c);
  return c.json({authenticated:!!u,user:u?{telegramId:u.telegram_id,displayName:u.display_name,isAdmin:u.is_admin}:null});
});
app.post("/api/auth/telegram", async (c) => {
  const raw = await c.req.json<Record<string,string>>();
  const identity = verifyTelegram(raw);
  if (!identity) return c.json({error:"telegram_signature_invalid_or_expired"},401);
  const bootstrap = identity.id === process.env.INITIAL_ADMIN_TELEGRAM_ID;
  const r = await pool.query(
    "INSERT INTO public.user_profiles(telegram_id,display_name,is_admin) VALUES($1,$2,$3) ON CONFLICT(telegram_id) DO UPDATE SET display_name=EXCLUDED.display_name, is_admin=public.user_profiles.is_admin OR EXCLUDED.is_admin, updated_at=now() RETURNING id,telegram_id,display_name,is_admin",
    [identity.id,identity.name,bootstrap]
  );
  const u=r.rows[0];
  const token=issueSession(String(u.id),String(u.telegram_id));
  c.header("Set-Cookie",sessionCookie(token));
  return c.json({authenticated:true,user:{telegramId:u.telegram_id,displayName:u.display_name,isAdmin:u.is_admin}});
});
app.post("/api/auth/logout", (c) => { c.header("Set-Cookie",cookieName+"=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0; Domain=.nettlegroup.space"); return c.json({ok:true}); });
app.get("/api/services", async (c) => {
  const r=await pool.query("SELECT id,slug,title,description,price_label,duration_days FROM public.service_catalog WHERE is_active=true ORDER BY sort_order,id");
  return c.json({services:r.rows});
});
app.get("/api/payment-methods", async (c) => {
  const r=await pool.query("SELECT id,slug,title,instructions,payment_details FROM public.payment_methods WHERE is_active=true ORDER BY sort_order,id");
  return c.json({paymentMethods:r.rows});
});
app.get("/api/tickets", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401);
  const r=await pool.query("SELECT id,order_code,service_id,status,payment_reference,admin_comment,created_at,updated_at FROM public.payment_tickets WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[u.id]);
  return c.json({tickets:r.rows});
});
app.post("/api/tickets", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401);
  const d=await c.req.json<any>(); const serviceId=Number(d.serviceId), methodId=Number(d.paymentMethodId);
  if(!Number.isSafeInteger(serviceId)||!Number.isSafeInteger(methodId)) return c.json({error:"service_and_payment_method_required"},400);
  const code="NTL-"+randomBytes(5).toString("hex").toUpperCase();
  const r=await pool.query("INSERT INTO public.payment_tickets(user_id,service_id,payment_method_id,order_code,status,amount_label) SELECT $1,s.id,p.id,$2,'awaiting_payment',s.price_label FROM public.service_catalog s CROSS JOIN public.payment_methods p WHERE s.id=$3 AND s.is_active=true AND p.id=$4 AND p.is_active=true RETURNING id,order_code,status,amount_label,service_id,payment_method_id,created_at",[u.id,code,serviceId,methodId]);
  if(!r.rowCount) return c.json({error:"service_or_payment_method_unavailable"},400);
  return c.json({ticket:r.rows[0]},201);
});
app.post("/api/ticket-paid", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401);
  const d=await c.req.json<any>(), ticketId=Number(d.ticketId);
  if(!Number.isSafeInteger(ticketId)||ticketId<1) return c.json({error:"ticket_id_required"},400);
  const r=await pool.query("UPDATE public.payment_tickets SET status='paid_submitted',payment_reference=$1,updated_at=now() WHERE id=$2 AND user_id=$3 AND status='awaiting_payment' RETURNING id,order_code,status",[String(d.paymentReference||"").slice(0,300),ticketId,u.id]);
  if(!r.rowCount) return c.json({error:"ticket_not_found_or_not_awaiting_payment"},409);
  return c.json({ticket:r.rows[0],notice:"Заявка отправлена администратору; оплата ещё не подтверждена."});
});
app.get("/api/admin/tickets", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const r=await pool.query("SELECT t.*,u.telegram_id,u.display_name,s.title AS service_title,p.title AS payment_method_title FROM public.payment_tickets t JOIN public.user_profiles u ON u.id=t.user_id LEFT JOIN public.service_catalog s ON s.id=t.service_id LEFT JOIN public.payment_methods p ON p.id=t.payment_method_id ORDER BY t.created_at DESC LIMIT 200");
  return c.json({tickets:r.rows});
});
app.post("/api/admin/ticket-decision", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const d=await c.req.json<any>(), id=Number(d.ticketId), decision=d.decision, comment=String(d.comment||"").slice(0,1000);
  if(!Number.isSafeInteger(id)||!["approved","rejected"].includes(decision)) return c.json({error:"invalid_request"},400);
  if(decision==="rejected"&&!comment.trim()) return c.json({error:"rejection_comment_required"},400);
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const t=await client.query("SELECT * FROM public.payment_tickets WHERE id=$1 FOR UPDATE",[id]);
    if(!t.rowCount||t.rows[0].status!=="paid_submitted"){await client.query("ROLLBACK");return c.json({error:"ticket_not_pending_review"},409);}
    const row=t.rows[0];
    await client.query("UPDATE public.payment_tickets SET status=$1,admin_comment=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$4",[decision,comment,u.id,id]);
    if(decision==="approved") {
      const s=row.service_id?await client.query("SELECT duration_days FROM public.service_catalog WHERE id=$1",[row.service_id]):{rows:[]};
      const days=s.rows.length?s.rows[0].duration_days:null;
      await client.query("INSERT INTO public.service_grants(user_id,service_id,ticket_id,granted_by,starts_at,expires_at,status,note) VALUES($1,$2,$3,$4,now(),CASE WHEN $5::int IS NULL THEN NULL ELSE now()+($5::text||' days')::interval END,'active',$6)",[row.user_id,row.service_id,id,u.id,days,"Одобрено по заказу "+row.order_code]);
    }
    await client.query("INSERT INTO public.audit_logs(actor_user_id,action,entity_type,entity_id,details) VALUES($1,$2,'payment_ticket',$3,$4::jsonb)",[u.id,"ticket_"+decision,String(id),JSON.stringify({orderCode:row.order_code,comment})]);
    await client.query("COMMIT");
    return c.json({ok:true,ticketId:id,status:decision});
  } catch(e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
});
app.get("/api/admin/grants", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const r=await pool.query("SELECT g.*,u.telegram_id,u.display_name,s.title AS service_title FROM public.service_grants g JOIN public.user_profiles u ON u.id=g.user_id LEFT JOIN public.service_catalog s ON s.id=g.service_id ORDER BY g.created_at DESC LIMIT 200");
  return c.json({grants:r.rows});
});
app.post("/api/admin/grants", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const d=await c.req.json<any>(), telegramId=String(d.telegramId||""), serviceId=d.serviceId==null?null:Number(d.serviceId), days=d.durationDays==null?null:Number(d.durationDays);
  if(!/^\d{5,20}$/.test(telegramId)||(serviceId!==null&&!Number.isSafeInteger(serviceId))||(days!==null&&(!Number.isSafeInteger(days)||days<1||days>3650))) return c.json({error:"invalid_grant"},400);
  const user=await pool.query("SELECT id FROM public.user_profiles WHERE telegram_id=$1",[telegramId]);
  if(!user.rowCount) return c.json({error:"user_not_found"},404);
  const r=await pool.query("INSERT INTO public.service_grants(user_id,service_id,granted_by,starts_at,expires_at,status,note) VALUES($1,$2,$3,now(),CASE WHEN $4::int IS NULL THEN NULL ELSE now()+($4::text||' days')::interval END,'active',$5) RETURNING *",[user.rows[0].id,serviceId,u.id,days,String(d.note||"Ручная выдача администратором").slice(0,1000)]);
  return c.json({grant:r.rows[0]},201);
});
app.get("/api/admin/services", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const r=await pool.query("SELECT * FROM public.service_catalog ORDER BY sort_order,id"); return c.json({services:r.rows});
});
app.post("/api/admin/services", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const d=await c.req.json<any>();
  if(!String(d.title||"").trim()) return c.json({error:"title_required"},400);
  const r=await pool.query("INSERT INTO public.service_catalog(slug,title,description,price_label,duration_days,is_active,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[String(d.slug||"service-"+Date.now()).slice(0,100),String(d.title).slice(0,160),String(d.description||"").slice(0,2000),String(d.priceLabel||"").slice(0,100),d.durationDays==null?null:Number(d.durationDays),d.isActive!==false,Number.isInteger(d.sortOrder)?d.sortOrder:100]);
  return c.json({service:r.rows[0]},201);
});
app.post("/api/admin/service-update", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const d=await c.req.json<any>(), id=Number(d.id);
  if(!Number.isSafeInteger(id)) return c.json({error:"service_id_required"},400);
  const r=await pool.query("UPDATE public.service_catalog SET title=COALESCE($1,title),description=COALESCE($2,description),price_label=COALESCE($3,price_label),duration_days=CASE WHEN $4 THEN $5 ELSE duration_days END,is_active=COALESCE($6,is_active),sort_order=COALESCE($7,sort_order),updated_at=now() WHERE id=$8 RETURNING *",[d.title==null?null:String(d.title).slice(0,160),d.description==null?null:String(d.description).slice(0,2000),d.priceLabel==null?null:String(d.priceLabel).slice(0,100),Object.prototype.hasOwnProperty.call(d,"durationDays"),d.durationDays==null||d.durationDays===""?null:Number(d.durationDays),typeof d.isActive==="boolean"?d.isActive:null,Number.isInteger(d.sortOrder)?d.sortOrder:null,id]);
  return r.rowCount?c.json({service:r.rows[0]}):c.json({error:"service_not_found"},404);
});
app.get("/api/admin/payment-methods", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const r=await pool.query("SELECT * FROM public.payment_methods ORDER BY sort_order,id"); return c.json({paymentMethods:r.rows});
});
app.post("/api/admin/payment-methods", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const d=await c.req.json<any>();
  if(!String(d.title||"").trim()) return c.json({error:"title_required"},400);
  const r=await pool.query("INSERT INTO public.payment_methods(slug,title,instructions,payment_details,is_active,sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[String(d.slug||"payment-"+Date.now()).slice(0,100),String(d.title).slice(0,160),String(d.instructions||"").slice(0,3000),String(d.paymentDetails||"").slice(0,1000),d.isActive!==false,Number.isInteger(d.sortOrder)?d.sortOrder:100]);
  return c.json({paymentMethod:r.rows[0]},201);
});
app.post("/api/admin/payment-method-update", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const d=await c.req.json<any>(), id=Number(d.id);
  if(!Number.isSafeInteger(id)) return c.json({error:"payment_method_id_required"},400);
  const r=await pool.query("UPDATE public.payment_methods SET title=COALESCE($1,title),instructions=COALESCE($2,instructions),payment_details=COALESCE($3,payment_details),is_active=COALESCE($4,is_active),sort_order=COALESCE($5,sort_order),updated_at=now() WHERE id=$6 RETURNING *",[d.title==null?null:String(d.title).slice(0,160),d.instructions==null?null:String(d.instructions).slice(0,3000),d.paymentDetails==null?null:String(d.paymentDetails).slice(0,1000),typeof d.isActive==="boolean"?d.isActive:null,Number.isInteger(d.sortOrder)?d.sortOrder:null,id]);
  return r.rowCount?c.json({paymentMethod:r.rows[0]}):c.json({error:"payment_method_not_found"},404);
});
app.get("/api/admin/settings", async (c) => {
  const u=await currentUser(c); if(!u) return c.json({error:"authentication_required"},401); if(!u.is_admin) return c.json({error:"admin_required"},403);
  const r=await pool.query("SELECT key,value,updated_at FROM public.site_settings ORDER BY key"); return c.json({settings:r.rows});
});

export default app;

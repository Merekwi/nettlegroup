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

const CAMPAIGN_GROUP_WEIGHTS={workers:0.25,business:0.16,rural:0.15,youth:0.13,publicSector:0.14,conservative:0.17};
const CAMPAIGN_ISSUES=[
{id:"budget",title:"Бюджет, налоги и государственный долг",context:"Казначейству нужно финансировать услуги, сдерживать дефицит и создавать условия для инвестиций. Каждое обещание придётся чем-то оплачивать.",question:"Как привести государственные финансы в порядок?",indicators:[{key:"treasury",label:"Казна"},{key:"debt",label:"Государственный долг"},{key:"taxRate",label:"Налоговая ставка"}],choices:[
{id:"tax_reform",title:"Справедливая налоговая реформа",description:"Повысить сборы с крупных доходов, закрыть схемы уклонения и защитить малый бизнес.",benefit:"Новые бюджетные доходы и более справедливая налоговая нагрузка.",risk:"Крупный бизнес может отложить инвестиции; доходы появятся не сразу.",groupEffects:{workers:5,business:-5,rural:0,youth:3,publicSector:4,conservative:-2},credibility:3,trust:1,fiscalImpactPct:-0.4,policyEffects:{taxRate:1,gdpGrowth:-0.1,publicServices:0.2}},
{id:"spending_review",title:"Аудит расходов и сокращение дефицита",description:"Пересмотреть закупки, субсидии и дублирующие ведомства, защитив ключевые социальные обязательства.",benefit:"Меньше давления на долг и более дисциплинированный бюджет.",risk:"Сокращения затронут госсектор и могут замедлить общественные услуги.",groupEffects:{workers:-5,business:3,rural:-2,youth:-3,publicSector:-6,conservative:3},credibility:3,trust:0,fiscalImpactPct:-0.8,policyEffects:{publicServices:-0.7,approval:-0.2,stability:0.1}},
{id:"development_bonds",title:"Заём для национальной программы инвестиций",description:"Выпустить долгосрочные облигации для транспорта, энергетики и производственных мощностей.",benefit:"Новые заказы, рабочие места и инвестиции в инфраструктуру.",risk:"Государственный долг и расходы на обслуживание вырастут.",groupEffects:{workers:2,business:-1,rural:2,youth:3,publicSector:2,conservative:-2},credibility:-2,trust:0,fiscalImpactPct:0.7,policyEffects:{debt:1.8,infrastructure:0.6,gdpGrowth:0.1}}
]},
{id:"prices",title:"Стоимость жизни и инфляция",context:"Домохозяйства жалуются на цены на продукты, жильё и энергию. Бизнес предупреждает, что резкие ограничения могут привести к дефициту.",question:"Как защитить покупательную способность?",indicators:[{key:"inflation",label:"Инфляция"},{key:"unemployment",label:"Безработица"},{key:"treasury",label:"Казна"}],choices:[
{id:"targeted_support",title:"Адресная поддержка семей",description:"Ввести временные выплаты малообеспеченным и компенсации коммунальных расходов с проверкой нуждаемости.",benefit:"Помощь направлена тем, кто сильнее всего страдает от роста цен.",risk:"Потребуются бюджетные средства и работающая проверка получателей.",groupEffects:{workers:5,business:-1,rural:3,youth:2,publicSector:3,conservative:1},credibility:1,trust:0,fiscalImpactPct:0.5,policyEffects:{approval:0.5,publicServices:0.3,inflation:-0.08}},
{id:"independent_cb",title:"Независимость центрального банка",description:"Сохранить денежно-кредитную дисциплину и не давить на регулятора ради краткосрочного роста.",benefit:"Повышается доверие к антиинфляционной политике и валюте.",risk:"Кредитование и занятость могут замедлиться до снижения инфляции.",groupEffects:{workers:-3,business:3,rural:-2,youth:-2,publicSector:-1,conservative:3},credibility:3,trust:1,fiscalImpactPct:-0.1,policyEffects:{inflation:-0.45,gdpGrowth:-0.08,unemployment:0.12}},
{id:"price_controls",title:"Временное ограничение цен",description:"Установить предельные цены на ограниченный набор товаров первой необходимости.",benefit:"Может быстро дать передышку семьям.",risk:"Без компенсаций поставщикам возможны дефицит, серый рынок и падение качества.",groupEffects:{workers:4,business:-6,rural:1,youth:1,publicSector:1,conservative:0},credibility:-2,trust:-1,fiscalImpactPct:0.25,policyEffects:{inflation:-0.1,corruption:0.35,approval:0.3}}
]},
{id:"jobs",title:"Рабочие места и промышленность",context:"Работники требуют достойной оплаты и защиты. Предприниматели настаивают на предсказуемых правилах и снижении издержек.",question:"Какая модель занятости станет основой роста?",indicators:[{key:"unemployment",label:"Безработица"},{key:"gdpGrowth",label:"Рост ВВП"},{key:"infrastructure",label:"Инфраструктура"}],choices:[
{id:"worker_rights",title:"Усилить коллективные переговоры",description:"Расширить роль профсоюзов, отраслевых соглашений и контроля трудового законодательства.",benefit:"Работники получают больше переговорной силы и защищённости.",risk:"Издержки компаний могут вырасти, особенно у малого бизнеса.",groupEffects:{workers:5,business:-5,rural:1,youth:3,publicSector:1,conservative:-2},credibility:1,trust:0,fiscalImpactPct:0.15,policyEffects:{unemployment:0.12,gdpGrowth:-0.08,approval:0.3}},
{id:"investment_credits",title:"Стимулы для инвестиций и найма",description:"Дать ограниченные по сроку льготы компаниям, которые создают рабочие места и обучают сотрудников.",benefit:"Может привлечь инвестиции и повысить производительность.",risk:"Есть риск субсидировать компании, которые наняли бы людей и без льгот.",groupEffects:{workers:2,business:5,rural:2,youth:4,publicSector:1,conservative:2},credibility:1,trust:0,fiscalImpactPct:0.45,policyEffects:{gdpGrowth:0.18,unemployment:-0.18}},
{id:"public_works",title:"Государственная программа общественных работ",description:"Запустить конкурсные проекты ремонта дорог, школ и водоснабжения в регионах с высокой безработицей.",benefit:"Быстрее создаются рабочие места и полезные объекты.",risk:"Высокая стоимость и риск неэффективных подрядов.",groupEffects:{workers:3,business:1,rural:4,youth:2,publicSector:4,conservative:-1},credibility:-1,trust:0,fiscalImpactPct:0.7,policyEffects:{infrastructure:0.9,unemployment:-0.1,debt:0.4}}
]},
{id:"regions",title:"Столица и регионы",context:"Столица концентрирует инвестиции и кадры, а отдалённые районы сталкиваются с нехваткой врачей, транспорта и рабочих мест.",question:"Как уменьшить территориальное неравенство?",indicators:[{key:"publicServices",label:"Госуслуги"},{key:"infrastructure",label:"Инфраструктура"},{key:"stability",label:"Стабильность"}],choices:[
{id:"regional_fund",title:"Фонд выравнивания регионов",description:"Распределять часть доходов по формуле бедности, населения и состояния инфраструктуры.",benefit:"Повышает доступность базовых услуг за пределами столицы.",risk:"Богатые регионы могут возражать против перераспределения.",groupEffects:{workers:2,business:-1,rural:5,youth:2,publicSector:4,conservative:1},credibility:0,trust:0,fiscalImpactPct:0.45,policyEffects:{publicServices:0.45,infrastructure:0.55,stability:0.1}},
{id:"regional_autonomy",title:"Самостоятельность регионов",description:"Передать регионам налоговые полномочия и право определять приоритеты в рамках общих стандартов.",benefit:"Местные власти лучше знают потребности жителей.",risk:"Богатые территории могут развиваться быстрее бедных.",groupEffects:{workers:-1,business:2,rural:2,youth:2,publicSector:-3,conservative:1},credibility:2,trust:1,fiscalImpactPct:-0.1,policyEffects:{stability:0.2,corruption:-0.25}},
{id:"export_corridors",title:"Региональные производственные коридоры",description:"Связать сельские районы, порты и промышленные центры логистикой и технопарками.",benefit:"Создаёт рынки, рабочие места и условия для инвестиций.",risk:"Результат потребует длительных вложений.",groupEffects:{workers:1,business:3,rural:4,youth:3,publicSector:0,conservative:1},credibility:1,trust:0,fiscalImpactPct:0.35,policyEffects:{gdpGrowth:0.16,infrastructure:0.4,unemployment:-0.06}}
]},
{id:"institutions",title:"Суды, коррупция и институты",context:"Бизнес требует независимого суда, общественные организации — прозрачности, а часть элит опасается пересмотра старых договорённостей.",question:"Как провести реформу институтов, не вызвав паралич власти?",indicators:[{key:"corruption",label:"Коррупция"},{key:"stability",label:"Стабильность"},{key:"approval",label:"Одобрение"}],choices:[
{id:"independent_courts",title:"Независимые суды и открытые закупки",description:"Изменить порядок назначения судей, раскрыть госконтракты и усилить контрольные органы.",benefit:"Повышает доверие к правилам и равенству перед законом.",risk:"Влиятельные группы будут сопротивляться; эффект проявится постепенно.",groupEffects:{workers:2,business:4,rural:1,youth:5,publicSector:-1,conservative:1},credibility:2,trust:5,fiscalImpactPct:0.08,policyEffects:{corruption:-0.65,democracyIndex:1.4,stability:-0.05}},
{id:"anti_corruption",title:"Жёсткая антикоррупционная кампания",description:"Проверить крупные контракты и расследовать злоупотребления специальными следственными группами.",benefit:"Быстрый сигнал о борьбе с безнаказанностью.",risk:"Без независимого суда расследования могут стать инструментом давления.",groupEffects:{workers:3,business:-3,rural:2,youth:1,publicSector:2,conservative:4},credibility:-1,trust:-1,fiscalImpactPct:0.1,policyEffects:{corruption:-0.2,approval:0.2,democracyIndex:-0.25}},
{id:"elite_pact",title:"Пакт с влиятельными политическими группами",description:"Договориться о гарантиях и постепенном обновлении институтов в обмен на поддержку реформ.",benefit:"Снижает риск немедленного саботажа.",risk:"Общество может воспринять соглашение как защиту старых элит.",groupEffects:{workers:-3,business:2,rural:-1,youth:-4,publicSector:1,conservative:3},credibility:0,trust:-3,fiscalImpactPct:0,policyEffects:{stability:0.35,corruption:0.3,democracyIndex:-0.8}}
]},
{id:"foreign_policy",title:"Безопасность и внешняя политика",context:"Стране приходится балансировать между военными рисками, торговыми интересами и самостоятельностью внешней политики.",question:"Какую международную стратегию предложит ваша партия?",indicators:[{key:"militaryPower",label:"Военный потенциал"},{key:"gdpGrowth",label:"Рост ВВП"},{key:"debt",label:"Государственный долг"}],choices:[
{id:"security_alliance",title:"Углубить оборонный союз",description:"Добиваться гарантий безопасности и координации закупок с надёжными партнёрами.",benefit:"Укрепляет сдерживание и уверенность союзников.",risk:"Снижает гибкость и требует дополнительных расходов.",groupEffects:{workers:-1,business:3,rural:-1,youth:1,publicSector:2,conservative:4},credibility:1,trust:1,fiscalImpactPct:0.3,policyEffects:{militaryPower:0.45,stability:0.1,gdpGrowth:-0.05}},
{id:"strategic_autonomy",title:"Стратегическая самостоятельность",description:"Сохранять сотрудничество с разными блоками, не принимая ограничивающих обязательств.",benefit:"Больше гибкости в кризисах и переговорах.",risk:"Партнёры могут сомневаться в надёжности курса.",groupEffects:{workers:1,business:1,rural:2,youth:1,publicSector:1,conservative:2},credibility:2,trust:1,fiscalImpactPct:0,policyEffects:{stability:0.2,militaryPower:0.1}},
{id:"trade_diplomacy",title:"Торговая дипломатия и экспортные соглашения",description:"Открывать рынки, развивать транспортные коридоры и диверсифицировать поставки.",benefit:"Поддерживает бизнес, занятость и рост.",risk:"Соглашения могут потребовать уступок и усилить внешнюю зависимость.",groupEffects:{workers:2,business:5,rural:3,youth:3,publicSector:1,conservative:-2},credibility:1,trust:1,fiscalImpactPct:0.1,policyEffects:{gdpGrowth:0.2,unemployment:-0.06}}
]}
];
function buildCampaignAgenda(){return CAMPAIGN_ISSUES.map(issue=>({id:issue.id,title:issue.title,context:issue.context,question:issue.question,indicators:issue.indicators.map(item=>({...item})),choices:issue.choices.map(({id,title,description,benefit,risk})=>({id,title,description,benefit,risk}))}));}
function createVoterGroups(approval=45,difficultyOffset=0){
 const base=clampNumber(45+(Number(approval)-50)*0.18+difficultyOffset,32,60),offsets={workers:0,business:-2,rural:-1,youth:1,publicSector:0,conservative:-1},groups={};
 for(const [key,offset] of Object.entries(offsets))groups[key]=Number(clampNumber(base+offset+crypto.randomInt(-4,5),18,68).toFixed(1));
 return groups;
}
function calculateCampaignSupport(groups,credibility=55,institutionalTrust=55,fiscalImpactPct=0){
 const weighted=Object.entries(CAMPAIGN_GROUP_WEIGHTS).reduce((sum,[key,weight])=>sum+Number(groups&&groups[key]||0)*weight,0);
 return Number(clampNumber(weighted+(Number(credibility)-55)*0.07+(Number(institutionalTrust)-55)*0.04-Math.max(0,Number(fiscalImpactPct||0)-1.1)*0.45,5,85).toFixed(1));
}

function assessPolicy(order, state) {
  const text = String(order || "").toLowerCase();
  const gdp = clampNumber(state.gdp || 350, 1, 100000000);
  const catalogue = [
    {match:/здрав|больниц|медицин|врач|клиник|health|hospital|medical/.test(text),category:"health",months:18,upfront:0.00075,monthly:0.00013,projectEffects:{healthcare:5,publicServices:2,approval:0.8}},
    {match:/образован|школ|университет|учител|education|school|university/.test(text),category:"education",months:24,upfront:0.0008,monthly:0.00015,projectEffects:{education:6,gdpGrowth:0.45,unemployment:-0.35}},
    {match:/налог|tax/.test(text)&&/сниз|уменьш|сократ|reduce|lower|cut/.test(text),category:"tax_cut",months:12,upfront:0.00055,monthly:0.00007,taxRate:-0.5,projectEffects:{gdpGrowth:0.38,approval:0.65,inflation:0.18}},
    {match:/налог|tax/.test(text)&&/повыс|увелич|поднять|raise|increase/.test(text),category:"tax_increase",months:12,upfront:0.00035,monthly:0.00004,taxRate:0.5,projectEffects:{gdpGrowth:-0.18,approval:-0.7,inflation:-0.12,stability:0.15}},
    {match:/арм|оборон|вооруж|военн|military|defen[cs]e|army/.test(text),category:"defense",months:18,upfront:0.001,monthly:0.00015,projectEffects:{militaryPower:3,stability:0.2}},
    {match:/дорог|мост|инфраструкт|строительств|железн|транспорт|infrastructure|road|rail/.test(text),category:"infrastructure",months:24,upfront:0.001,monthly:0.00018,projectEffects:{infrastructure:7,gdpGrowth:0.55,unemployment:-0.4,approval:0.5}},
    {match:/коррупц|взятк|прозрачност|аудит|corruption|anti-corruption/.test(text),category:"anti_corruption",months:18,upfront:0.00055,monthly:0.00008,projectEffects:{corruption:-5,approval:0.8,stability:1}},
    {match:/зарплат|пенси|пособ|субсиди|социальн|wage|pension|benefit|subsid/.test(text),category:"social",months:12,upfront:0.0007,monthly:0.00013,projectEffects:{approval:1,unemployment:-0.2,inflation:0.18}},
    {match:/энерг|электр|эколог|климат|энерго|energy|environment|climate/.test(text),category:"energy_environment",months:20,upfront:0.0009,monthly:0.00014,projectEffects:{infrastructure:2.5,gdpGrowth:0.25,inflation:-0.35}},
    {match:/внешн|дипломат|торгов|экспорт|импорт|соглашен|договор|foreign|diplomac|trade|export|import|treaty/.test(text),category:"foreign_policy",months:12,upfront:0.00035,monthly:0.00005,projectEffects:{stability:0.3,gdpGrowth:0.12}},
    {match:true,category:"general",months:6,upfront:0.00025,monthly:0.00004,projectEffects:{publicServices:0.5,approval:0.15}}
  ];
  const rule=catalogue.find(item=>item.match)||catalogue[catalogue.length-1];
  return {
    category:rule.category,
    durationMonths:rule.months,
    budgetCost:Number((gdp*rule.upfront).toFixed(2)),
    budgetRevenue:0,
    monthlyCost:Math.max(0.01,Number((gdp*rule.monthly).toFixed(2))),
    announcementApproval:0.05,
    taxRate:rule.taxRate||0,
    projectEffects:rule.projectEffects
  };
}
async function draftOfficialDocument(order, game, effects) {
  const titles = {
    health:"О мерах по модернизации системы здравоохранения",
    education:"О реализации национальной программы развития образования",
    tax_cut:"О внесении изменений в налоговую политику",
    tax_increase:"О внесении изменений в налоговую систему",
    defense:"О мерах по укреплению обороноспособности государства",
    infrastructure:"О реализации государственной программы развития инфраструктуры",
    anti_corruption:"О мерах по обеспечению прозрачности государственного управления",
    social:"О дополнительных мерах социальной поддержки населения",
    energy_environment:"О развитии энергетической инфраструктуры",
    foreign_policy:"О мерах по развитию международного сотрудничества",
    general:"О мерах по реализации государственной политики"
  };
  const fallback = {
    title:titles[effects.category]||titles.general,
    summary:"Руководствуясь Конституцией и законами государства, в целях обеспечения устойчивого развития, надлежащего исполнения государственных обязательств и защиты общественных интересов, постановляю:",
    body:"1. Утвердить государственную программу по следующему направлению: «"+order+"».\n\n2. Определить ответственным за координацию исполнения профильное министерство. Министерству обеспечить подготовку календарного плана мероприятий, перечня ответственных исполнителей и измеримых показателей результата.\n\n3. Министерству финансов обеспечить первоначальное финансирование в пределах утверждённых бюджетных ассигнований в размере "+effects.budgetCost+" млрд долларов США и последующее ежемесячное финансирование в размере "+effects.monthlyCost+" млрд долларов США.\n\n4. Установить срок реализации программы — "+effects.durationMonths+" месяцев со дня вступления настоящего Указа в силу.\n\n5. Правительству ежеквартально представлять Президенту доклад о ходе исполнения, освоении средств, достигнутых результатах и выявленных рисках.\n\n6. Контроль за исполнением настоящего Указа возложить на Руководителя Администрации Президента.\n\n7. Настоящий Указ вступает в силу со дня его официального опубликования."
  };
  const apiKey=process.env.OPENROUTER_API_KEY, model=process.env.OPENROUTER_MODEL;
  if(!apiKey||!model)return fallback;
  try{
    const response=await fetch("https://openrouter.ai/api/v1/chat/completions",{
      method:"POST",
      headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json","HTTP-Referer":"https://merekwi.github.io/presedento-sim/","X-Title":"Presidential Simulator"},
      body:JSON.stringify({
        model,temperature:0.25,max_tokens:1200,
        messages:[
          {role:"system",content:"Ты специалист по нормотворчеству и юридической технике. Составляй формальные проекты нормативных указов для вымышленного государства. Стиль строгий официальный: название начинается с «О…»; юридическая преамбула; отдельная строка «ПОСТАНОВЛЯЮ:»; пронумерованные распорядительные пункты; конкретно укажи ответственное министерство, сроки, бюджетные лимиты, порядок отчётности и дату вступления в силу. Не пиши разговорно и не выдумывай номера законов, названия реальных ведомств или суммы. Переданные финансовые значения и сроки используй точно. Возвращай только JSON с полями title, summary, body."},
          {role:"user",content:JSON.stringify({country:game.name_local||game.name_en,president:game.president_name,initiative:order,initialFunding:effects.budgetCost,monthlyFunding:effects.monthlyCost,implementationMonths:effects.durationMonths,returnSchema:{title:"string",summary:"string",body:"string"}})}
        ]
      }),
      signal:AbortSignal.timeout(25000)
    });
    if(!response.ok)throw new Error("OpenRouter HTTP "+response.status);
    const payload=await response.json(),content=payload.choices&&payload.choices[0]&&payload.choices[0].message&&payload.choices[0].message.content;
    if(!content)return fallback;
    const clean=String(content).replace(/^\s*[\u0060]{3}(?:json)?/i,"").replace(/[\u0060]{3}\s*$/,"").trim();
    const parsed=JSON.parse(clean);
    return {
      title:typeof parsed.title==="string"&&parsed.title.trim()?parsed.title.trim().slice(0,220):fallback.title,
      summary:typeof parsed.summary==="string"&&parsed.summary.trim()?parsed.summary.trim().slice(0,1200):fallback.summary,
      body:typeof parsed.body==="string"&&parsed.body.trim()?parsed.body.trim().slice(0,12000):fallback.body
    };
  }catch(error){console.error("OpenRouter decree draft failed:",error.message);return fallback;}
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

    if (path === "/api/presidential/game/election/decision" && req.method === "POST") {
      if(!gameUser)return out(res,401,{error:"authentication_required"});
      const input=await readBody(req),issueId=txt(input.issueId,40),choiceId=txt(input.choiceId,48);
      const issue=CAMPAIGN_ISSUES.find(item=>item.id===issueId),choice=issue&&issue.choices.find(item=>item.id===choiceId);
      if(!issue||!choice)return out(res,400,{error:"invalid_campaign_decision"});
      const client=await presidentialPool.connect();
      try{
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if(!saved.rowCount){await client.query("ROLLBACK");return out(res,409,{error:"active_game_not_found"});}
        const game=saved.rows[0],state={...(game.state||{})},election={...(state.election||{})};
        if(state.phase!=="election_campaign"&&state.phase!=="election"){await client.query("ROLLBACK");return out(res,409,{error:"no_active_election"});}
        const index=Number(election.issueIndex||0),agenda=Array.isArray(election.agenda)?election.agenda:[];
        const expected=CAMPAIGN_ISSUES[index];
        if(!expected||expected.id!==issueId||agenda[index]?.id!==issueId){await client.query("ROLLBACK");return out(res,409,{error:"campaign_issue_out_of_order",expectedIssue:expected?.id||null});}
        const groups={...(election.voterGroups||{})};
        for(const [key,delta] of Object.entries(choice.groupEffects||{}))groups[key]=Number(clampNumber(Number(groups[key]||40)+Number(delta||0),8,82).toFixed(1));
        election.voterGroups=groups;
        election.fiscalImpactPct=Number((Number(election.fiscalImpactPct||0)+Number(choice.fiscalImpactPct||0)).toFixed(2));
        election.policyCredibility=Number(clampNumber(Number(election.policyCredibility||55)+Number(choice.credibility||0)-Math.max(0,election.fiscalImpactPct-1.1)*0.25,5,95).toFixed(1));
        election.institutionalTrust=Number(clampNumber(Number(election.institutionalTrust||55)+Number(choice.trust||0),5,95).toFixed(1));
        const policyEffects={...(election.policyEffects||{})};
        for(const [key,value] of Object.entries(choice.policyEffects||{}))policyEffects[key]=Number((Number(policyEffects[key]||0)+Number(value||0)).toFixed(3));
        election.policyEffects=policyEffects;
        election.issueIndex=index+1;
        election.decisions=[...(Array.isArray(election.decisions)?election.decisions:[]),{issueId,issueTitle:issue.title,choiceId,choiceTitle:choice.title,policyEffects:choice.policyEffects,fiscalImpactPct:choice.fiscalImpactPct}];
        election.candidateSupport=calculateCampaignSupport(groups,election.policyCredibility,election.institutionalTrust,election.fiscalImpactPct);
        election.oppositionSupport=Number((100-election.candidateSupport).toFixed(1));
        election.currentIssue=CAMPAIGN_ISSUES[index+1]?.id||null;
        state.election=election;
        await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(state),game.id]);
        const headline=issue.title+": "+choice.title;
        const article=choice.description+" Преимущество: "+choice.benefit+" Риск: "+choice.risk;
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'campaign_policy',$3,$4,1,$5::jsonb)",[game.id,game.game_date,headline,article,JSON.stringify({issueId,choiceId,candidateSupport:election.candidateSupport,policyCredibility:election.policyCredibility,institutionalTrust:election.institutionalTrust,fiscalImpactPct:election.fiscalImpactPct})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'election_policy_decision',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({issueId,choiceId,issueIndex:election.issueIndex,candidateSupport:election.candidateSupport})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,election,message:"Решение учтено в программе партии."});
      }catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    }

    if (path === "/api/presidential/game/election/campaign" && req.method === "POST") {
      return out(res,410,{error:"legacy_four_action_campaign_removed",replacement:"/api/presidential/game/election/decision"});
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
        const agendaLength=Array.isArray(election.agenda)?election.agenda.length:0;if(!agendaLength||Number(election.issueIndex||0)<agendaLength){await client.query("ROLLBACK");return out(res,409,{error:"campaign_decisions_remaining",remaining:Math.max(0,agendaLength-Number(election.issueIndex||0))});}
        const noise=crypto.randomInt(-2,3);
        const voteShare=Number(clampNumber(calculateCampaignSupport(election.voterGroups||{},election.policyCredibility||55,election.institutionalTrust||55,election.fiscalImpactPct||0)+noise,5,95).toFixed(1));
        const won=voteShare>=50;
        const electionDate=election.scheduledDate || game.game_date;
        if (won) {
          state.phase="government";
          state.electionsWon=Number(state.electionsWon||0)+1;
          state.nextElectionDate=election.firstElection ? (Number(state.startYear||2026)+4)+"-01-01" : (() => { const d=new Date(String(electionDate).slice(0,10)+"T00:00:00Z"); d.setUTCFullYear(d.getUTCFullYear()+4); return d.toISOString().slice(0,10); })();
          state.approval=clampNumber(Number(state.approval||50)+4,0,100);
          state.policyMandate={status:"active",monthsElapsed:0,durationMonths:12,effects:election.policyEffects||{},fiscalImpactPct:Number(election.fiscalImpactPct||0),decisions:election.decisions||[]};
          state.democracyIndex=clampNumber(Number(state.democracyIndex??55)+(Number(election.institutionalTrust||55)-55)*0.12,0,100);
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
        presidentialPool.query("SELECT d.id,d.other_country_id,d.other_country_name,d.relation_score,d.status,d.treaties,c.iso2,c.flag_emoji FROM diplomatic_relations d LEFT JOIN countries c ON c.id=d.other_country_id WHERE d.save_id=$1 ORDER BY d.relation_score DESC,d.other_country_name",[game.id]),
        presidentialPool.query("SELECT id,unit_type,quantity,readiness,supply FROM military_units WHERE save_id=$1 ORDER BY unit_type",[game.id]),
        presidentialPool.query("SELECT id,game_date,event_type,headline,article,severity,effects FROM game_events WHERE save_id=$1 ORDER BY game_date DESC,created_at DESC LIMIT 12",[game.id]),
        presidentialPool.query("SELECT id,decree_number,title,summary,body,status,effects,created_at,published_at FROM decrees WHERE save_id=$1 ORDER BY decree_number DESC LIMIT 12",[game.id])
      ]);
      return out(res,200,{game,ministers:ministers.rows,relations:relations.rows,units:units.rows,events:events.rows,decrees:decrees.rows});
    }

    if (path === "/api/presidential/game/program" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req), action=txt(input.action,24), projectId=txt(input.projectId,40);
      const catalog={
        health_modernization:{title:"Модернизация здравоохранения",category:"Социальная сфера",months:18,initialPct:0.0012,monthlyPct:0.00018,effects:{healthcare:6,publicServices:2,approval:1.2}},
        school_reform:{title:"Реформа школьного и высшего образования",category:"Человеческий капитал",months:24,initialPct:0.0013,monthlyPct:0.00020,effects:{education:7,gdpGrowth:0.55,unemployment:-0.45}},
        transport_network:{title:"Национальная транспортная сеть",category:"Инфраструктура",months:30,initialPct:0.0020,monthlyPct:0.00030,effects:{infrastructure:9,gdpGrowth:0.72,approval:1.1}},
        digital_government:{title:"Цифровое государство и аудит",category:"Госуправление",months:16,initialPct:0.0010,monthlyPct:0.00014,effects:{corruption:-7,publicServices:6,stability:1.2}},
        industrial_zones:{title:"Промышленные и технологические зоны",category:"Промышленность",months:24,initialPct:0.0020,monthlyPct:0.00026,effects:{gdpGrowth:0.82,unemployment:-0.8,infrastructure:2}},
        energy_security:{title:"Энергетическая устойчивость",category:"Энергетика",months:24,initialPct:0.0018,monthlyPct:0.00024,effects:{infrastructure:3,gdpGrowth:0.34,inflation:-0.55}}
      };
      if (!["start","cancel"].includes(action)||!catalog[projectId]) return out(res,400,{error:"invalid_program"});
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if (!saved.rowCount) { await client.query("ROLLBACK"); return out(res,409,{error:"active_game_not_found"}); }
        const game=saved.rows[0],state={...(game.state||{})},points=Number(state.actionPoints??2);
        if (state.phase && state.phase!=="government") { await client.query("ROLLBACK"); return out(res,409,{error:"election_campaign_in_progress"}); }
        if (points<1) { await client.query("ROLLBACK"); return out(res,409,{error:"no_action_points"}); }
        const projects=Array.isArray(state.projects)?state.projects:[];
        const definition=catalog[projectId];
        if (action==="start") {
          if (projects.some(project=>project.projectId===projectId&&project.status==="active")) { await client.query("ROLLBACK"); return out(res,409,{error:"program_already_active"}); }
          if (projects.filter(project=>project.status==="active").length>=3) { await client.query("ROLLBACK"); return out(res,409,{error:"too_many_active_programs"}); }
          const upfront=Number((Math.max(1,Number(state.gdp||350))*definition.initialPct).toFixed(2));
          if (Number(state.treasury||0)<upfront) { await client.query("ROLLBACK"); return out(res,409,{error:"insufficient_treasury",required:upfront,available:state.treasury}); }
          state.treasury=Number((Number(state.treasury)-upfront).toFixed(2));
          state.budgetBalance=Number((Number(state.budgetBalance||0)-upfront).toFixed(2));
          const project={projectId,title:definition.title,category:definition.category,durationMonths:definition.months,monthsCompleted:0,upfrontCost:upfront,monthlyCost:Math.max(0.01,Number((Number(state.gdp||350)*definition.monthlyPct).toFixed(2))),effects:definition.effects,status:"active",startedAt:String(game.game_date).slice(0,10)};
          projects.push(project);
          state.projects=projects;
          state.actionPoints=points-1;
          await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'government_program',$3,$4,1,$5::jsonb)",[game.id,game.game_date,"Запущена государственная программа: "+definition.title,"Проект рассчитан на "+definition.months+" месяцев. Первоначальное финансирование: "+upfront+" млрд $, последующие платежи будут списываться ежемесячно.",JSON.stringify({projectId,upfront,monthlyCost:project.monthlyCost,durationMonths:definition.months})]);
        } else {
          const project=projects.find(item=>item.projectId===projectId&&item.status==="active");
          if (!project) { await client.query("ROLLBACK"); return out(res,404,{error:"active_program_not_found"}); }
          project.status="cancelled";
          project.cancelledAt=String(game.game_date).slice(0,10);
          state.projects=projects;
          state.actionPoints=points-1;
          await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'government_program',$3,$4,2,$5::jsonb)",[game.id,game.game_date,"Государственная программа остановлена","Программа «"+project.title+"» отменена. Уже понесённые расходы не возвращаются.",JSON.stringify({projectId,monthsCompleted:project.monthsCompleted})]);
        }
        await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(state),game.id]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'government_program_'+$3,$4::jsonb)",[gameUser.id,game.id,action,JSON.stringify({projectId,projects:projects.length})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,projects,state});
      } catch(error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    }

    if (path === "/api/presidential/game/action" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      return out(res,410,{error:"instant_policy_actions_removed",message:"Use long-term government programs. Instant indicator boosts are disabled."});
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
        const mandate=state.policyMandate||null,mandateEffects={};
        let mandateBudgetDelta=0;
        const mandateActive=Boolean(mandate&&mandate.status==="active"&&Number(mandate.monthsElapsed||0)<Number(mandate.durationMonths||12));
        if(mandateActive){
          const duration=Math.max(1,Number(mandate.durationMonths||12));
          for(const [key,total] of Object.entries(mandate.effects||{}))mandateEffects[key]=Number(total||0)/duration;
          mandateBudgetDelta=Number((-gdp*Number(mandate.fiscalImpactPct||0)/100/duration).toFixed(2));
          mandate.monthsElapsed=Number(mandate.monthsElapsed||0)+1;
          if(mandate.monthsElapsed>=duration)mandate.status="completed";
          state.policyMandate=mandate;
        }
        const ministers=await client.query("SELECT portfolio,competence,loyalty,traits FROM ministers WHERE save_id=$1 AND dismissed_at IS NULL",[game.id]);
        const projectEffects={gdpGrowth:0,inflation:0,unemployment:0,approval:0,stability:0,corruption:0,publicServices:0,education:0,healthcare:0,infrastructure:0,militaryPower:0};
        let projectOutflow=0;
        const activeProjects=Array.isArray(state.projects)?state.projects:[];
        for(const project of activeProjects.filter(item=>item.status==="active")){
          const payment=Number(project.monthlyCost||0);
          if(Number(state.treasury||0)<payment){project.paused=true;continue;}
          project.paused=false;
          state.treasury=Number((Number(state.treasury||0)-payment).toFixed(2));
          projectOutflow+=payment;
          project.monthsCompleted=Math.min(Number(project.durationMonths||1),Number(project.monthsCompleted||0)+1);
          for(const [key,total] of Object.entries(project.effects||{})){
            if(Object.prototype.hasOwnProperty.call(projectEffects,key)) projectEffects[key]+=Number(total)/Number(project.durationMonths||1);
          }
          if(project.monthsCompleted>=Number(project.durationMonths||1)){
            project.status="completed";
            project.completedAt=String(game.game_date).slice(0,10);
          }
        }
        state.projects=activeProjects;
        const treatyRows=await client.query("SELECT treaties FROM diplomatic_relations WHERE save_id=$1",[game.id]);
        const treatyEffects={gdpGrowth:0,inflation:0,unemployment:0,stability:0};
        for(const row of treatyRows.rows){
          const pack=row.treaties&&typeof row.treaties==="object"&&!Array.isArray(row.treaties)?row.treaties:{};
          for(const treaty of (Array.isArray(pack.activeDeals)?pack.activeDeals:Array.isArray(row.treaties)?row.treaties:[])){
            if(treaty.status!=="active") continue;
            for(const [key,value] of Object.entries(treaty.monthlyEffects||{})) if(Object.prototype.hasOwnProperty.call(treatyEffects,key)) treatyEffects[key]+=Number(value||0);
          }
        }
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
        state.gdpGrowth=clampNumber(Number(state.gdpGrowth||0)+(infrastructure-50)*0.004+(education-50)*0.002-(corruption-30)*0.001+ministerEffects.gdpGrowth+projectEffects.gdpGrowth+treatyEffects.gdpGrowth+Number(mandateEffects.gdpGrowth||0)+event.growth,-15,20);
        state.taxRate=Number(clampNumber(Number(state.taxRate||22)+Number(mandateEffects.taxRate||0),0,70).toFixed(2));
        const monthlyBalance=Number((gdp*((Number(state.taxRate||22)-21.5)/100/12)+mandateBudgetDelta).toFixed(2));
        const netBudget=Number((monthlyBalance-projectOutflow).toFixed(2));
        state.treasury=Number(Math.max(0,Number(state.treasury||0)+monthlyBalance+event.treasury+ministerEffects.budgetBalance*0.05).toFixed(2));
        state.budgetBalance=netBudget;
        state.debt=Number(clampNumber(Number(state.debt||0)+(netBudget<0?Math.abs(netBudget)/gdp*100:0)+Number(mandateEffects.debt||0),0,500).toFixed(2));
        state.democracyIndex=Number(clampNumber(Number(state.democracyIndex??55)+Number(mandateEffects.democracyIndex||0),0,100).toFixed(2));
        state.gdp=Number((gdp*(1+state.gdpGrowth/1200)).toFixed(2));
        state.inflation=Number(clampNumber(Number(state.inflation||3)+event.inflation+(state.gdpGrowth>5?0.07:-0.02)+(Math.random()-0.5)*0.12+ministerEffects.inflation+projectEffects.inflation+treatyEffects.inflation+Number(mandateEffects.inflation||0),0,100).toFixed(2));
        state.unemployment=Number(clampNumber(Number(state.unemployment||5)-state.gdpGrowth*0.025+0.025+(Math.random()-0.5)*0.18+ministerEffects.unemployment+projectEffects.unemployment+treatyEffects.unemployment+Number(mandateEffects.unemployment||0),0,60).toFixed(2));
        state.approval=Number(clampNumber(Number(state.approval||50)+event.approval+(state.gdpGrowth-2)*0.16-(state.inflation-3)*0.045-(state.unemployment-5)*0.10+(Number(state.publicServices||58)-55)*0.045+ministerEffects.approval+projectEffects.approval+Number(mandateEffects.approval||0),0,100).toFixed(2));
        state.stability=Number(clampNumber(Number(state.stability||60)+event.stability+(state.approval-50)*0.025-(corruption-35)*0.018+ministerEffects.stability+projectEffects.stability+treatyEffects.stability+Number(mandateEffects.stability||0),0,100).toFixed(2));
        for (const key of ["publicServices","education","healthcare","infrastructure","militaryPower"]) {
          if (ministerEffects[key]||projectEffects[key]||mandateEffects[key]) state[key]=Number(clampNumber(Number(state[key]||50)+ministerEffects[key]+projectEffects[key]+Number(mandateEffects[key]||0),0,100).toFixed(2));
        }
        state.corruption=Number(clampNumber(Number(state.corruption||30)+ministerEffects.corruption+projectEffects.corruption+Number(mandateEffects.corruption||0),0,100).toFixed(2));
        state.actionPoints=2;
        const updated=await client.query("UPDATE game_saves SET state=$1::jsonb,turn_number=turn_number+1,game_date=game_date+interval '1 month',updated_at=now() WHERE id=$2 RETURNING id,game_date,turn_number,state",[JSON.stringify(state),game.id]);
        const newDate=String(updated.rows[0].game_date).slice(0,10);
        let electionStarted=false;
        if (!state.dictatorship && state.nextElectionDate) {
          const triggerDate=new Date(String(state.nextElectionDate).slice(0,10)+"T00:00:00Z");
          triggerDate.setUTCMonth(triggerDate.getUTCMonth()-3);
          if (new Date(newDate+"T00:00:00Z")>=triggerDate) {
            const voterGroups=createVoterGroups(Number(state.approval||45),0);
            const policyCredibility=crypto.randomInt(48,64);
            const institutionalTrust=Number(clampNumber(state.democracyIndex??55,5,95).toFixed(1));
            const support=calculateCampaignSupport(voterGroups,policyCredibility,institutionalTrust,0);
            state.phase="election";
            state.election={
              kind:state.election&&state.election.kind||"presidential",
              type:state.election&&state.election.type||"Национальные выборы",
              partyName:state.election&&state.election.partyName||"Партия национального развития",
              candidateSupport:Number(support.toFixed(1)),oppositionSupport:Number((100-support).toFixed(1)),
              voterGroups,policyCredibility,institutionalTrust,fiscalImpactPct:0,policyEffects:{},agenda:buildCampaignAgenda(),issueIndex:0,currentIssue:CAMPAIGN_ISSUES[0].id,decisions:[],
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
          ministerEffects,projectEffects,treatyEffects
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
      const input=await readBody(req),action=txt(input.action,32),relationId=txt(input.relationId,64);
      const client=await presidentialPool.connect();
      try {
        await client.query("BEGIN");
        const saved=await client.query("SELECT * FROM game_saves WHERE owner_user_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if(!saved.rowCount){await client.query("ROLLBACK");return out(res,409,{error:"active_game_not_found"});}
        const game=saved.rows[0],state={...(game.state||{})},points=Number(state.actionPoints??2);
        if(state.phase&&state.phase!=="government"){await client.query("ROLLBACK");return out(res,409,{error:"election_campaign_in_progress"});}
        if(points<1){await client.query("ROLLBACK");return out(res,409,{error:"no_action_points"});}
        const found=await client.query("SELECT * FROM diplomatic_relations WHERE id=$1 AND save_id=$2 FOR UPDATE",[relationId,game.id]);
        if(!found.rowCount){await client.query("ROLLBACK");return out(res,404,{error:"diplomatic_relation_not_found"});}
        const relation=found.rows[0],raw=relation.treaties&&typeof relation.treaties==="object"?relation.treaties:[];
        const pack=Array.isArray(raw)?{talks:null,proposal:null,activeDeals:raw}:raw;
        let talks=pack.talks||null,proposal=pack.proposal||null;
        const costFor=amount=>Number(Math.max(0.02,Number(state.gdp||350)*amount).toFixed(2));
        let cost=0,score=Number(relation.relation_score||0),headline="",article="",result={};
        if(action==="consultations"){
          if(talks&&talks.status==="open"){await client.query("ROLLBACK");return out(res,409,{error:"talks_already_open"});}
          cost=costFor(0.000025);
          if(Number(state.treasury||0)<cost){await client.query("ROLLBACK");return out(res,409,{error:"insufficient_treasury"});}
          talks={status:"open",openedTurn:Number(game.turn_number),openedAt:String(game.game_date).slice(0,10)};
          proposal=null;
          headline="Открыты дипломатические консультации с "+relation.other_country_name;
          article="Стороны согласовали повестку переговоров. Консультации не означают автоматического улучшения отношений: дальнейший результат зависит от условий и позиции партнёра.";
        } else if(action==="propose_trade"||action==="propose_security"){
          if(!talks||talks.status!=="open"){await client.query("ROLLBACK");return out(res,409,{error:"open_consultations_required"});}
          if(proposal&&proposal.status==="pending"){await client.query("ROLLBACK");return out(res,409,{error:"proposal_already_pending"});}
          cost=costFor(action==="propose_trade"?0.00005:0.00008);
          if(Number(state.treasury||0)<cost){await client.query("ROLLBACK");return out(res,409,{error:"insufficient_treasury"});}
          const type=action==="propose_trade"?"trade":"security";
          proposal={type,status:"pending",proposedTurn:Number(game.turn_number),replyTurn:Number(game.turn_number)+2,proposedAt:String(game.game_date).slice(0,10)};
          headline=type==="trade"?"Предложено торговое соглашение":"Предложен договор о сотрудничестве в сфере безопасности";
          article="Предложение передано правительству "+relation.other_country_name+". Ответ ожидается после двух игровых месяцев. До ратификации соглашение не оказывает экономического или военного эффекта.";
        } else if(action==="resolve_proposal"){
          if(!proposal||proposal.status!=="pending"){await client.query("ROLLBACK");return out(res,409,{error:"no_pending_proposal"});}
          if(Number(game.turn_number)<Number(proposal.replyTurn)){await client.query("ROLLBACK");return out(res,409,{error:"partner_needs_more_time",replyTurn:proposal.replyTurn});}
          const type=proposal.type;
          const diplomacyMinister=await client.query("SELECT competence,loyalty,traits FROM ministers WHERE save_id=$1 AND portfolio='Иностранные дела' AND dismissed_at IS NULL ORDER BY appointed_at DESC LIMIT 1",[game.id]);
          const ministerSkill=diplomacyMinister.rowCount?(Number(diplomacyMinister.rows[0].competence)-50)*0.12:0;
          const chance=clampNumber((type==="trade"?48:28)+(score*0.30)+ministerSkill+(Number(state.stability||50)-50)*0.08-(Number(state.corruption||30)-30)*0.04,8,88);
          const accepted=crypto.randomInt(1,101)<=chance;
          if(accepted){
            const monthlyEffects=type==="trade"?{gdpGrowth:0.035,inflation:-0.008}:{stability:0.025};
            const deal={type,status:"active",signedAt:String(game.game_date).slice(0,10),monthlyEffects};
            pack.activeDeals=[...(Array.isArray(pack.activeDeals)?pack.activeDeals:[]),deal];
            score=clampNumber(score+(type==="trade"?5:3),-100,100);
            headline=type==="trade"?"Подписано торговое соглашение":"Подписан договор о сотрудничестве в сфере безопасности";
            article="Правительство "+relation.other_country_name+" приняло предложение. Соглашение вступает в силу и будет давать ограниченный эффект каждый месяц, пока остаётся действующим.";
            result={accepted:true,chance:Number(chance.toFixed(1)),deal};
          } else {
            score=clampNumber(score-4,-100,100);
            headline="Переговоры с "+relation.other_country_name+" не привели к соглашению";
            article="Партнёр отклонил предложение. Внешнеполитическое ведомство должно пересмотреть условия или вернуться к консультациям позже.";
            result={accepted:false,chance:Number(chance.toFixed(1))};
          }
          proposal={...proposal,status:accepted?"accepted":"rejected",resolvedTurn:Number(game.turn_number)};
          pack.talks={...(talks||{}),status:"closed"};
          pack.proposal=proposal;
        } else if(action==="sanctions"){
          if(score>-25){await client.query("ROLLBACK");return out(res,409,{error:"sanctions_threshold_not_met"});}
          if(pack.activeDeals) pack.activeDeals=pack.activeDeals.filter(deal=>deal.type!=="trade");
          cost=costFor(0.00012);
          score=clampNumber(score-12,-100,100);
          state.gdpGrowth=clampNumber(Number(state.gdpGrowth||0)-0.08,-20,30);
          state.approval=clampNumber(Number(state.approval||50)-0.2,0,100);
          headline="Правительство ввело ограничительные меры против "+relation.other_country_name;
          article="Санкции введены после длительного дипломатического кризиса. Торговля и политические контакты с партнёром ограничены.";
        } else {
          await client.query("ROLLBACK");return out(res,400,{error:"invalid_diplomatic_action"});
        }
        if(cost>0){
          if(Number(state.treasury||0)<cost){await client.query("ROLLBACK");return out(res,409,{error:"insufficient_treasury",required:cost,available:state.treasury});}
          state.treasury=Number((Number(state.treasury)-cost).toFixed(2));
          state.budgetBalance=Number((Number(state.budgetBalance||0)-cost).toFixed(2));
        }
        state.actionPoints=points-1;
        const status=score>=55?"allied":score>=20?"friendly":score<=-45?"hostile":score<=-20?"strained":"neutral";
        const updated=await client.query("UPDATE diplomatic_relations SET relation_score=$1,status=$2,treaties=$3::jsonb,updated_at=now() WHERE id=$4 RETURNING id,other_country_name,relation_score,status,treaties",[score,status,JSON.stringify(pack),relationId]);
        await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2",[JSON.stringify(state),game.id]);
        if(!headline){
          headline=action==="consultations"?"Открыты дипломатические консультации":action==="propose_trade"?"Подготовлено торговое предложение":"Подготовлено предложение о сотрудничестве";
          article="Министерство иностранных дел продолжает работу над международным соглашением.";
        }
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'diplomacy',$3,$4,$5,$6::jsonb)",[game.id,game.game_date,headline,relation.other_country_name+": "+article,action==="sanctions"?3:1,JSON.stringify({action,cost,relationScore:score,...result})]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'diplomatic_action',$3::jsonb)",[gameUser.id,game.id,JSON.stringify({action,country:relation.other_country_name,relationScore:score,...result})]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,relation:updated.rows[0],actionPoints:state.actionPoints,...result});
      }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
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
      const input=await readBody(req),decreeId=txt(input.decreeId,64);
      if(!/^[0-9a-f-]{36}$/i.test(decreeId))return out(res,400,{error:"invalid_decree_id"});
      const client=await presidentialPool.connect();
      try{
        await client.query("BEGIN");
        const saved=await client.query("SELECT s.* FROM game_saves s WHERE s.owner_user_id=$1 AND s.status='active' ORDER BY s.updated_at DESC LIMIT 1 FOR UPDATE",[gameUser.telegram_id]);
        if(!saved.rowCount){await client.query("ROLLBACK");return out(res,409,{error:"active_game_not_found"});}
        const game=saved.rows[0],state={...(game.state||{})};
        if(state.phase&&state.phase!=="government"){await client.query("ROLLBACK");return out(res,409,{error:"election_campaign_in_progress"});}
        const d=await client.query("SELECT * FROM decrees WHERE id=$1 AND save_id=$2 FOR UPDATE",[decreeId,game.id]);
        if(!d.rowCount){await client.query("ROLLBACK");return out(res,404,{error:"decree_not_found"});}
        if(d.rows[0].status!=="draft"){await client.query("ROLLBACK");return out(res,409,{error:"decree_not_draft"});}
        const actionPoints=Number.isFinite(Number(state.actionPoints))?Number(state.actionPoints):2;
        if(actionPoints<1){await client.query("ROLLBACK");return out(res,409,{error:"no_action_points"});}
        const projects=Array.isArray(state.projects)?state.projects:[];
        if(projects.filter(project=>project.status==="active").length>=3){await client.query("ROLLBACK");return out(res,409,{error:"too_many_active_programs"});}
        const effects=assessPolicy(d.rows[0].original_order,state);
        const treasury=Number(state.treasury||0);
        if(treasury<effects.budgetCost){await client.query("ROLLBACK");return out(res,409,{error:"insufficient_treasury",required:effects.budgetCost,available:treasury});}
        state.actionPoints=actionPoints-1;
        state.treasury=Number((treasury-effects.budgetCost+effects.budgetRevenue).toFixed(2));
        state.budgetBalance=Number((Number(state.budgetBalance||0)-effects.budgetCost+effects.budgetRevenue).toFixed(2));
        state.debt=clampNumber(Number(state.debt||0)+(effects.budgetCost/Math.max(1,Number(state.gdp||1)))*100,0,500);
        if(effects.taxRate)state.taxRate=clampNumber(Number(state.taxRate||0)+effects.taxRate,0,70);
        state.approval=clampNumber(Number(state.approval||50)+Number(effects.announcementApproval||0),0,100);
        const project={
          projectId:"decree_"+decreeId,
          title:d.rows[0].title,
          category:effects.category,
          durationMonths:effects.durationMonths,
          monthsCompleted:0,
          upfrontCost:effects.budgetCost,
          monthlyCost:effects.monthlyCost,
          effects:effects.projectEffects,
          status:"active",
          paused:false,
          sourceDecreeId:decreeId,
          decreeNumber:d.rows[0].decree_number,
          startedAt:String(game.game_date).slice(0,10)
        };
        projects.push(project);
        state.projects=projects;
        const updated=await client.query("UPDATE game_saves SET state=$1::jsonb,updated_at=now() WHERE id=$2 RETURNING id,game_date,turn_number,state",[JSON.stringify(state),game.id]);
        await client.query("UPDATE decrees SET status='published',effects=$1::jsonb,published_at=now() WHERE id=$2",[JSON.stringify(effects),decreeId]);
        const article="Указ №"+d.rows[0].decree_number+" опубликован. Ответственное министерство приступает к исполнению программы сроком "+effects.durationMonths+" месяцев. Первоначальное финансирование составляет "+effects.budgetCost+" млрд $, последующее ежемесячное финансирование — "+effects.monthlyCost+" млрд $. Результаты будут учитываться по мере выполнения мероприятий.";
        await client.query(
          "INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'decree',$3,$4,1,$5::jsonb)",
          [game.id,game.game_date,d.rows[0].title,article,JSON.stringify({decreeId,decreeNumber:d.rows[0].decree_number,projectId:project.projectId,effects})]
        );
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'decree_published',$3::jsonb)",[
          gameUser.id,game.id,JSON.stringify({decreeId,decreeNumber:d.rows[0].decree_number,project,effects})
        ]);
        await client.query("COMMIT");
        return out(res,200,{ok:true,game:updated.rows[0],effects,project});
      }catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    }

    if (path === "/api/presidential/game/new" && req.method === "POST") {
      if (!gameUser) return out(res,401,{error:"authentication_required"});
      const input=await readBody(req),difficulty=txt(input.difficulty,20);
      const difficultyOptions={
        easy:{label:"Облегчённая",treasury:1.25,approval:8,stability:7,debt:-5},
        normal:{label:"Обычная",treasury:1,approval:0,stability:0,debt:0},
        hard:{label:"Сложная",treasury:0.72,approval:-9,stability:-12,debt:12}
      };
      if(!difficultyOptions[difficulty])return out(res,400,{error:"invalid_campaign_difficulty"});
      const countryResult=await presidentialPool.query("SELECT * FROM countries WHERE iso2 IS NOT NULL ORDER BY random() LIMIT 1");
      if(!countryResult.rowCount)return out(res,503,{error:"country_catalog_empty"});
      const country=countryResult.rows[0],baseline=country.baseline_state||{};
      const base=(key,fallback)=>Number.isFinite(Number(baseline[key]))?Number(baseline[key]):fallback;
      const startYear=new Date().getUTCFullYear(),yearDate=String(startYear)+"-01-01";
      const candidatePools={
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
      const names=candidatePools[country.iso2]||["Alex Morgan","Maya Patel","Daniel Novak","Sofia Martin","Noah Chen"];
      const president=names[crypto.randomInt(names.length)],age=crypto.randomInt(34,70);
      const portraitId="p"+String(crypto.randomInt(1,17)).padStart(2,"0");
      const backgrounds=[
        {label:"бывший руководитель региональной администрации",groups:{rural:2,publicSector:2,workers:1},trust:1},
        {label:"экономист и специалист по государственным финансам",groups:{business:2,publicSector:1,workers:-1},trust:2},
        {label:"предприниматель и руководитель частных компаний",groups:{business:4,conservative:1,publicSector:-2},trust:0},
        {label:"общественный деятель и организатор социальных инициатив",groups:{workers:2,youth:3,publicSector:1,business:-1},trust:2},
        {label:"опытный дипломат и бывший представитель страны за рубежом",groups:{business:1,youth:1,conservative:2},trust:3},
        {label:"политик из независимого регионального движения",groups:{rural:3,youth:2,publicSector:-1,conservative:1},trust:1}
      ];
      const background=backgrounds[crypto.randomInt(backgrounds.length)],difficultyRule=difficultyOptions[difficulty];
      const state={
        gdp:base("gdp",350),gdpGrowth:base("gdpGrowth",2.1),inflation:base("inflation",3.2),
        unemployment:base("unemployment",5.4),approval:base("approval",45),stability:base("stability",60),
        budgetBalance:base("budgetBalance",0),treasury:base("treasury",30),population:base("population",25),
        militaryPower:base("militaryPower",48),publicServices:base("publicServices",55),corruption:base("corruption",34),
        debt:base("debt",55),taxRate:base("taxRate",22),education:base("education",55),
        healthcare:base("healthcare",58),infrastructure:base("infrastructure",52),actionPoints:2,
        difficulty:difficulty,presidentPortrait:portraitId,startYear:startYear,phase:"election_campaign",
        dictatorship:false,electionsWon:0,nextElectionDate:null,democracyIndex:base("democracyIndex",55)
      };
      state.treasury=Number((state.treasury*difficultyRule.treasury).toFixed(2));
      state.approval=Number(clampNumber(state.approval+difficultyRule.approval,0,100).toFixed(2));
      state.stability=Number(clampNumber(state.stability+difficultyRule.stability,0,100).toFixed(2));
      state.debt=Number(clampNumber(state.debt+difficultyRule.debt,0,500).toFixed(2));
      const voterGroups=createVoterGroups(state.approval,0);
      for(const [key,value] of Object.entries(background.groups))voterGroups[key]=Number(clampNumber(voterGroups[key]+value,8,82).toFixed(1));
      const policyCredibility=crypto.randomInt(50,66);
      const institutionalTrust=Number(clampNumber(state.democracyIndex+background.trust,5,95).toFixed(1));
      const campaignTitle=country.name_local||country.name_en;
      const bio="Кандидат на выборную государственную должность, "+age+" лет; "+background.label+". Имя, внешность и государство определены случайным образом. Сложность симуляции: "+difficultyRule.label.toLowerCase()+"."
      state.election={
        kind:/парламент|монарх/i.test(String(country.government_type||""))?"parliamentary":"presidential",
        type:/парламент|монарх/i.test(String(country.government_type||""))?"Парламентские выборы":"Президентские выборы",
        partyName:txt(input.partyName,80)||"Партия национального развития",
        candidateSupport:calculateCampaignSupport(voterGroups,policyCredibility,institutionalTrust,0),
        oppositionSupport:0,voterGroups,policyCredibility,institutionalTrust,
        fiscalImpactPct:0,policyEffects:{},agenda:buildCampaignAgenda(),issueIndex:0,
        currentIssue:CAMPAIGN_ISSUES[0].id,decisions:[],scheduledDate:yearDate,firstElection:true,round:1
      };
      state.election.oppositionSupport=Number((100-state.election.candidateSupport).toFixed(1));
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
          "SELECT id,name_local,name_en,region FROM countries WHERE id<>$1 AND iso2 IS NOT NULL ORDER BY CASE WHEN region=$2 THEN 0 ELSE 1 END,name_en",
          [country.id,country.region]
        );
        for (const n of neighbours.rows) {
          const sameRegion=String(n.region||"")===String(country.region||"");
          const relationScore=sameRegion?crypto.randomInt(7,19):crypto.randomInt(-6,8);
          const relationStatus=relationScore>=55?"allied":relationScore>=20?"friendly":relationScore<=-45?"hostile":relationScore<=-20?"strained":"neutral";
          await client.query(
            "INSERT INTO diplomatic_relations(save_id,other_country_id,other_country_name,relation_score,status,treaties) VALUES($1,$2,$3,$4,$5,'[]'::jsonb)",
            [save.id,n.id,n.name_local || n.name_en,relationScore,relationStatus]
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
        const startArticle="В "+(country.name_local||country.name_en)+" начинается общенациональная избирательная кампания. Кандидат "+president+", "+age+" лет, выдвинут партией «"+state.election.partyName+"». Биография кандидата: "+background.label+". Стартовые условия: "+difficultyRule.label.toLowerCase()+".";
        await client.query("INSERT INTO game_events(save_id,game_date,event_type,headline,article,severity,effects) VALUES($1,$2,'election_campaign',$3,$4,2,'{}'::jsonb)",[save.id,yearDate,"Партия выдвинула кандидата на общенациональные выборы",startArticle]);
        await client.query("INSERT INTO audit_log(user_id,save_id,action,details) VALUES($1,$2,'campaign_created',$3::jsonb)",[
          gameUser.id,save.id,JSON.stringify({countryId:country.id,iso2:country.iso2,presidentName:president,presidentAge:age,difficulty,startYear,portraitId,randomized:true})
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
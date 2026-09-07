const KIS_BASE = "https://openapi.koreainvestment.com:9443";
const DART_BASE = "https://opendart.fss.or.kr/api";
const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";
const ECOS_BASE = "https://ecos.bok.or.kr/api";

let kisTokenCache = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === "/api/ping") {
        return json({
          ok: true,
          app: "FF Value Hunter",
          version: "0.1.0",
          authRequired: Boolean(env.APP_ACCESS_KEY),
        });
      }

      assertAccess(request, env);

      if (url.pathname === "/api/config-status") {
        return json({
          ok: true,
          configured: {
            dart: Boolean(env.DART_API_KEY),
            kis: Boolean(env.KIS_APP_KEY && env.KIS_APP_SECRET),
            krx: Boolean(env.KRX_AUTH_KEY),
            ecos: Boolean(env.ECOS_API_KEY),
          },
          note: "Only presence/absence is returned. Secret values are never exposed.",
        });
      }

      if (url.pathname === "/api/test/dart") {
        requireEnv(env, ["DART_API_KEY"]);
        const data = await dartCompany(env, url.searchParams.get("corp") || "00126380");
        return json({ ok: data.status === "000", provider: "OpenDART", sample: slimDartCompany(data), rawStatus: data.status, message: data.message });
      }

      if (url.pathname === "/api/test/kis") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeCode(url.searchParams.get("code") || "005930");
        const data = await kisCurrentPrice(env, code);
        return json({ ok: data.rt_cd === "0", provider: "KIS", sample: slimCurrentPrice(data.output), rawStatus: data.rt_cd, message: data.msg1 });
      }

      if (url.pathname === "/api/test/krx") {
        requireEnv(env, ["KRX_AUTH_KEY"]);
        const basDd = url.searchParams.get("date") || lastWeekdayYYYYMMDD();
        const data = await krxKospiDaily(env, basDd);
        return json({ ok: Array.isArray(data.OutBlock_1), provider: "KRX", date: basDd, rows: data.OutBlock_1?.length || 0, sample: data.OutBlock_1?.[0] || null, raw: data });
      }

      if (url.pathname === "/api/test/ecos") {
        requireEnv(env, ["ECOS_API_KEY"]);
        const data = await ecosKeyStatistics(env, 5);
        const rows = data?.KeyStatisticList?.row || [];
        return json({ ok: rows.length > 0, provider: "ECOS", rows: rows.length, sample: rows.slice(0, 5), raw: data });
      }

      if (url.pathname === "/api/analyze") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeCode(url.searchParams.get("code") || "005930");
        const corp = (url.searchParams.get("corp") || "").trim();

        const [chartRaw, investorRaw, dailyRaw, priceRaw] = await Promise.all([
          kisDailyChart(env, code, 160),
          kisInvestor(env, code),
          kisDailyPrice30(env, code),
          kisCurrentPrice(env, code),
        ]);

        const priceOutput = priceRaw.output || {};
        const technical = analyzeTechnical(chartRaw);
        const supply = analyzeSupply(investorRaw.output || [], dailyRaw.output || []);
        const snapshot = slimCurrentPrice(priceOutput);

        let dart = null;
        if (corp) {
          if (!env.DART_API_KEY) {
            dart = { ok: false, error: "DART_API_KEY is not configured" };
          } else {
            const company = await dartCompany(env, corp);
            const financials = await dartFinancials(env, corp, String(new Date().getUTCFullYear() - 1), "11011", "CFS");
            dart = {
              ok: company.status === "000",
              company: slimDartCompany(company),
              financials: summarizeFinancials(financials?.list || []),
              note: "If CFS is unavailable, use OFS in a later version. v0.2 will automate stock-code to DART corp-code mapping.",
            };
          }
        }

        return json({
          ok: true,
          code,
          analyzedAt: new Date().toISOString(),
          snapshot,
          technical,
          supply,
          dart,
          ffVersion: "0.1",
          implementation: {
            industry: "partial - stock industry label only; sector-index wave analysis is v0.2",
            financial: corp ? "partial - latest annual DART snapshot" : "not run - enter DART corp code",
            supply: "active - foreign/institution accumulation scoring",
            technical: "active - MA20/60/120 and price location",
            timing: "partial - 60/120-day zone only",
          },
          warning: "This is a screening/analysis tool, not an automatic trading or order system.",
        });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error?.message || String(error) }, error?.status || 500);
    }
  },
};

function assertAccess(request, env) {
  if (!env.APP_ACCESS_KEY) return;
  const supplied = request.headers.get("x-app-key") || "";
  if (supplied !== env.APP_ACCESS_KEY) {
    const error = new Error("Access key is missing or invalid");
    error.status = 401;
    throw error;
  }
}

function requireEnv(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    const error = new Error(`Missing Cloudflare secret(s): ${missing.join(", ")}`);
    error.status = 500;
    throw error;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function normalizeCode(value) {
  const code = String(value || "").trim();
  if (!/^\d{6}$/.test(code)) {
    const error = new Error("Stock code must be exactly 6 digits, e.g. 005930");
    error.status = 400;
    throw error;
  }
  return code;
}

async function fetchJson(url, options = {}, label = "API") {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}: ${data?.msg1 || data?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function kisToken(env) {
  const now = Date.now();
  if (kisTokenCache && kisTokenCache.expiresAt > now + 60_000) {
    return kisTokenCache.token;
  }

  const data = await fetchJson(`${KIS_BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
    }),
  }, "KIS OAuth");

  if (!data.access_token) {
    throw new Error(`KIS token issuance failed: ${data.error_description || data.msg1 || "no access_token"}`);
  }

  const expiresIn = Number(data.expires_in || 21_600);
  kisTokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max(300, expiresIn - 120) * 1000,
  };
  return data.access_token;
}

async function kisGet(env, path, trId, params) {
  const token = await kisToken(env);
  const qs = new URLSearchParams(params);
  const url = `${KIS_BASE}${path}?${qs.toString()}`;
  const data = await fetchJson(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: env.KIS_APP_KEY,
      appsecret: env.KIS_APP_SECRET,
      tr_id: trId,
      custtype: "P",
    },
  }, `KIS ${path}`);

  if (data.rt_cd && data.rt_cd !== "0") {
    throw new Error(`KIS error ${data.msg_cd || data.rt_cd}: ${data.msg1 || "unknown error"}`);
  }
  return data;
}

async function kisCurrentPrice(env, code) {
  return kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-price", "FHKST01010100", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_ISCD: code,
  });
}

async function kisDailyPrice30(env, code) {
  return kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-daily-price", "FHKST01010400", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_ISCD: code,
    FID_PERIOD_DIV_CODE: "D",
    FID_ORG_ADJ_PRC: "0",
  });
}

async function kisInvestor(env, code) {
  return kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-investor", "FHKST01010900", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_INPUT_ISCD: code,
  });
}

async function kisDailyChart(env, code, targetRows = 160) {
  const collected = new Map();
  let end = new Date();

  for (let page = 0; page < 3 && collected.size < targetRows; page++) {
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 220);

    const data = await kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice", "FHKST03010100", {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0",
    });

    const rows = data.output2 || data.output || [];
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      if (row.stck_bsop_date) collected.set(row.stck_bsop_date, row);
    }

    const dates = rows.map((r) => r.stck_bsop_date).filter(Boolean).sort();
    if (!dates.length) break;
    const oldest = parseYYYYMMDD(dates[0]);
    oldest.setUTCDate(oldest.getUTCDate() - 1);
    end = oldest;
  }

  return [...collected.values()].sort((a, b) => String(a.stck_bsop_date).localeCompare(String(b.stck_bsop_date)));
}

async function dartCompany(env, corpCode) {
  if (!/^\d{8}$/.test(String(corpCode))) {
    const error = new Error("DART corp code must be exactly 8 digits, e.g. 00126380");
    error.status = 400;
    throw error;
  }
  const qs = new URLSearchParams({ crtfc_key: env.DART_API_KEY, corp_code: corpCode });
  return fetchJson(`${DART_BASE}/company.json?${qs}`, {}, "OpenDART company");
}

async function dartFinancials(env, corpCode, year, reprtCode = "11011", fsDiv = "CFS") {
  const qs = new URLSearchParams({
    crtfc_key: env.DART_API_KEY,
    corp_code: corpCode,
    bsns_year: year,
    reprt_code: reprtCode,
    fs_div: fsDiv,
  });
  return fetchJson(`${DART_BASE}/fnlttSinglAcntAll.json?${qs}`, {}, "OpenDART financials");
}

async function krxKospiDaily(env, basDd) {
  if (!/^\d{8}$/.test(String(basDd))) {
    const error = new Error("KRX date must be YYYYMMDD");
    error.status = 400;
    throw error;
  }
  return fetchJson(`${KRX_BASE}/sto/stk_bydd_trd?basDd=${basDd}`, {
    headers: { AUTH_KEY: env.KRX_AUTH_KEY },
  }, "KRX KOSPI daily");
}

async function ecosKeyStatistics(env, count = 5) {
  return fetchJson(`${ECOS_BASE}/KeyStatisticList/${encodeURIComponent(env.ECOS_API_KEY)}/json/kr/1/${count}`, {}, "ECOS KeyStatisticList");
}

function analyzeTechnical(rows) {
  const clean = (rows || [])
    .map((r) => ({
      date: r.stck_bsop_date,
      close: num(r.stck_clpr),
      volume: num(r.acml_vol),
    }))
    .filter((r) => r.date && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (clean.length < 120) {
    return { ok: false, rows: clean.length, message: "At least 120 trading days are required for MA120 analysis." };
  }

  const closes = clean.map((r) => r.close);
  const last = clean[clean.length - 1];
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const ma120 = sma(closes, 120);
  const ma60Ago10 = sma(closes.slice(0, -10), 60);
  const ma120Ago10 = sma(closes.slice(0, -10), 120);
  const aligned = last.close > ma20 && ma20 > ma60 && ma60 > ma120;
  const rising = ma60 > ma60Ago10 && ma120 > ma120Ago10;
  const between60and120 = last.close <= ma60 && last.close >= ma120;

  let zone = "above_ma20";
  if (between60and120) zone = "between_ma60_ma120";
  else if (last.close < ma120) zone = "below_ma120";
  else if (last.close < ma60) zone = "between_ma20_ma60_or_below_ma20";

  return {
    ok: true,
    rows: clean.length,
    date: last.date,
    close: round(last.close),
    ma20: round(ma20),
    ma60: round(ma60),
    ma120: round(ma120),
    ma60Slope10dPct: pct(ma60, ma60Ago10),
    ma120Slope10dPct: pct(ma120, ma120Ago10),
    aligned,
    rising,
    wavePass: aligned && rising,
    zone,
    closeVsMa120Pct: pct(last.close, ma120),
    rule: "close > MA20 > MA60 > MA120 and both MA60/MA120 rising over 10 trading days",
  };
}

function analyzeSupply(investorRows, dailyRows) {
  const rows = (investorRows || [])
    .map((r) => ({
      date: r.stck_bsop_date,
      foreign: num(r.frgn_ntby_qty),
      institution: num(r.orgn_ntby_qty),
    }))
    .filter((r) => r.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  const daily = (dailyRows || [])
    .map((r) => ({
      date: r.stck_bsop_date,
      foreignExhaustion: num(r.hts_frgn_ehrt),
      foreignNet: num(r.frgn_ntby_qty),
    }))
    .filter((r) => r.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  const f5 = sum(rows.slice(0, 5), "foreign");
  const f20 = sum(rows.slice(0, 20), "foreign");
  const f30 = sum(rows.slice(0, 30), "foreign");
  const i5 = sum(rows.slice(0, 5), "institution");
  const i20 = sum(rows.slice(0, 20), "institution");
  const i30 = sum(rows.slice(0, 30), "institution");

  const fPositive20 = rows.slice(0, 20).filter((r) => r.foreign > 0).length;
  const iPositive20 = rows.slice(0, 20).filter((r) => r.institution > 0).length;
  const bothPositive20 = rows.slice(0, 20).filter((r) => r.foreign > 0 && r.institution > 0).length;
  const fStreak = positiveStreak(rows, "foreign");
  const iStreak = positiveStreak(rows, "institution");

  const newestRate = daily[0]?.foreignExhaustion;
  const oldestRate = daily[Math.min(daily.length, 30) - 1]?.foreignExhaustion;
  const foreignHoldingRateDelta = Number.isFinite(newestRate) && Number.isFinite(oldestRate) ? round(newestRate - oldestRate, 2) : null;

  let score = 0;
  if (f5 > 0) score += 5;
  if (f20 > 0) score += 10;
  if (f30 > 0) score += 10;
  if (fPositive20 >= 12) score += 10;
  if (fStreak >= 3) score += 5;
  if (foreignHoldingRateDelta !== null && foreignHoldingRateDelta > 0) score += 10;

  if (i5 > 0) score += 5;
  if (i20 > 0) score += 10;
  if (i30 > 0) score += 10;
  if (iPositive20 >= 12) score += 10;
  if (iStreak >= 3) score += 5;

  if (f20 > 0 && i20 > 0) score += 5;
  if (bothPositive20 >= 8) score += 5;

  score = Math.min(100, score);

  let label = "weak_or_mixed";
  if (score >= 80) label = "strong_accumulation";
  else if (score >= 60) label = "accumulation";
  else if (score >= 40) label = "watch";

  return {
    ok: rows.length > 0,
    rows: rows.length,
    score,
    label,
    foreign: {
      net5d: f5,
      net20d: f20,
      net30d: f30,
      positiveDays20: fPositive20,
      currentPositiveStreak: fStreak,
      exhaustionRateNow: Number.isFinite(newestRate) ? newestRate : null,
      exhaustionRate30dAgo: Number.isFinite(oldestRate) ? oldestRate : null,
      exhaustionRateDelta30d: foreignHoldingRateDelta,
    },
    institution: {
      net5d: i5,
      net20d: i20,
      net30d: i30,
      positiveDays20: iPositive20,
      currentPositiveStreak: iStreak,
      holdingTrendMethod: "Cumulative net buying proxy; direct institution holding history is not supplied by this endpoint.",
    },
    joint: {
      bothPositiveDays20: bothPositive20,
      bothNetPositive20d: f20 > 0 && i20 > 0,
    },
    scoreRule: "Persistent foreign/institution accumulation is weighted more heavily than one-day buying; foreign holding-rate trend also receives bonus points.",
  };
}

function slimCurrentPrice(o = {}) {
  return {
    name: o.hts_kor_isnm || null,
    industry: o.bstp_kor_isnm || null,
    price: numOrNull(o.stck_prpr),
    marketCap100MKRW: numOrNull(o.hts_avls),
    per: numOrNull(o.per),
    pbr: numOrNull(o.pbr),
    eps: numOrNull(o.eps),
    bps: numOrNull(o.bps),
    listedShares: numOrNull(o.lstn_stcn),
    foreignHoldingQty: numOrNull(o.frgn_hldn_qty),
    foreignExhaustionRate: numOrNull(o.hts_frgn_ehrt),
    warningCode: o.mrkt_warn_cls_code || null,
    investmentCaution: o.invt_caful_yn || null,
    managementIssue: o.mang_issu_cls_code || null,
  };
}

function slimDartCompany(d = {}) {
  return {
    corpCode: d.corp_code || null,
    corpName: d.corp_name || null,
    stockCode: d.stock_code || null,
    ceo: d.ceo_nm || null,
    corpClass: d.corp_cls || null,
    industryCode: d.induty_code || null,
    fiscalMonth: d.acc_mt || null,
  };
}

function summarizeFinancials(rows) {
  const normalized = (rows || []).map((r) => ({
    name: r.account_nm,
    amount: numOrNull(r.thstrm_amount),
    before: numOrNull(r.frmtrm_amount),
    statement: r.sj_nm,
    fsDiv: r.fs_div,
  }));

  const pick = (patterns) => normalized.find((r) => patterns.some((p) => p.test(String(r.name || "")))) || null;
  return {
    revenue: pick([/^매출액$/, /수익\(매출액\)/, /^영업수익$/]),
    operatingIncome: pick([/^영업이익/, /^영업이익\(손실\)/]),
    netIncome: pick([/^당기순이익/, /^당기순이익\(손실\)/]),
    assets: pick([/^자산총계$/]),
    liabilities: pick([/^부채총계$/]),
    equity: pick([/^자본총계$/]),
  };
}

function sma(values, n) {
  if (values.length < n) return NaN;
  const arr = values.slice(-n);
  return arr.reduce((a, b) => a + b, 0) / n;
}

function sum(rows, key) {
  return Math.round((rows || []).reduce((acc, r) => acc + (Number.isFinite(r[key]) ? r[key] : 0), 0));
}

function positiveStreak(rows, key) {
  let count = 0;
  for (const row of rows || []) {
    if (row[key] > 0) count += 1;
    else break;
  }
  return count;
}

function num(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function round(v, digits = 0) {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
}

function pct(now, before) {
  if (!Number.isFinite(now) || !Number.isFinite(before) || before === 0) return null;
  return round(((now / before) - 1) * 100, 2);
}

function yyyymmdd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function parseYYYYMMDD(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  return new Date(Date.UTC(y, m - 1, d));
}

function lastWeekdayYYYYMMDD() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return yyyymmdd(d);
}

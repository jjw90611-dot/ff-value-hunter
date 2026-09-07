const KIS_BASE = "https://openapi.koreainvestment.com:9443";
const DART_BASE = "https://opendart.fss.or.kr/api";
const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";
const ECOS_BASE = "https://ecos.bok.or.kr/api";
const APP_VERSION = "0.2.0";

const REQUIRED_BINDINGS = [
  "APP_ACCESS_KEY",
  "DART_API_KEY",
  "KIS_APP_KEY",
  "KIS_APP_SECRET",
  "KRX_AUTH_KEY",
  "ECOS_API_KEY",
];

let kisTokenCache = null;
let kisTokenPromise = null;

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
          version: APP_VERSION,
          authRequired: hasBinding(env, "APP_ACCESS_KEY"),
        });
      }

      assertAccess(request, env);

      if (url.pathname === "/api/config-status") {
        const configured = {
          access: hasBinding(env, "APP_ACCESS_KEY"),
          dart: hasBinding(env, "DART_API_KEY"),
          kis: hasBinding(env, "KIS_APP_KEY") && hasBinding(env, "KIS_APP_SECRET"),
          krx: hasBinding(env, "KRX_AUTH_KEY"),
          ecos: hasBinding(env, "ECOS_API_KEY"),
        };
        const detected = REQUIRED_BINDINGS.filter((name) => hasBinding(env, name));
        const missing = REQUIRED_BINDINGS.filter((name) => !hasBinding(env, name));
        return json({
          ok: true,
          version: APP_VERSION,
          configured,
          runtimeBindingsDetected: detected,
          missing,
          deployHint: missing.length
            ? "Cloudflare Settings > Variables and Secrets에서 값을 저장한 뒤 반드시 Deploy를 눌러 현재 Worker 버전에 반영하세요. GitHub 자동배포를 쓰는 경우 wrangler.jsonc의 keep_vars=true가 대시보드 Text 변수를 보존합니다."
            : "필수 바인딩이 현재 실행 중인 Worker에서 모두 감지됩니다.",
        });
      }

      if (url.pathname === "/api/test/dart") {
        requireEnv(env, ["DART_API_KEY"]);
        const data = await dartCompany(env, url.searchParams.get("corp") || "00126380");
        return json({
          ok: data.status === "000",
          provider: "OpenDART",
          sample: slimDartCompany(data),
          rawStatus: data.status,
          message: data.message,
        });
      }

      if (url.pathname === "/api/test/kis") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeCode(url.searchParams.get("code") || "005930");
        const data = await kisCurrentPrice(env, code);
        return json({
          ok: data.rt_cd === "0",
          provider: "KIS",
          sample: slimCurrentPrice(data.output),
          rawStatus: data.rt_cd,
          message: data.msg1,
        });
      }

      if (url.pathname === "/api/test/krx") {
        requireEnv(env, ["KRX_AUTH_KEY"]);
        const basDd = url.searchParams.get("date") || lastWeekdayYYYYMMDD();
        const data = await krxKospiDaily(env, basDd);
        return json({
          ok: Array.isArray(data.OutBlock_1),
          provider: "KRX",
          date: basDd,
          rows: data.OutBlock_1?.length || 0,
          sample: data.OutBlock_1?.[0] || null,
        });
      }

      if (url.pathname === "/api/test/ecos") {
        requireEnv(env, ["ECOS_API_KEY"]);
        const data = await ecosKeyStatistics(env, 5);
        const rows = data?.KeyStatisticList?.row || [];
        return json({ ok: rows.length > 0, provider: "ECOS", rows: rows.length, sample: rows.slice(0, 5) });
      }

      if (url.pathname === "/api/analyze") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeCode(url.searchParams.get("code") || "005930");
        const corp = (url.searchParams.get("corp") || "").trim();

        const calls = await Promise.all([
          safeSource("일봉 차트", () => kisDailyChart(env, code, 190)),
          safeSource("외국인·기관 수급", () => kisInvestor(env, code)),
          safeSource("외국인 보유비율", () => kisDailyPrice30(env, code)),
          safeSource("현재가", () => kisCurrentPrice(env, code)),
          safeSource("연간 손익계산서", () => kisIncomeStatement(env, code, "0")),
          safeSource("분기 손익계산서", () => kisIncomeStatement(env, code, "1")),
          safeSource("재무비율", () => kisFinancialRatio(env, code, "0")),
        ]);

        const [chartRes, investorRes, dailyRes, priceRes, annualRes, quarterRes, ratioRes] = calls;
        if (!priceRes.ok) {
          throw new Error(`KIS 현재가 조회 실패: ${priceRes.error}`);
        }

        const sourceErrors = calls
          .filter((item) => !item.ok)
          .map((item) => ({ label: item.label, error: item.error }));

        const chartRaw = chartRes.value || [];
        const investorRaw = investorRes.value || {};
        const dailyRaw = dailyRes.value || {};
        const priceRaw = priceRes.value || {};
        const annualIncomeRaw = annualRes.value || {};
        const quarterIncomeRaw = quarterRes.value || {};
        const ratioRaw = ratioRes.value || {};

        const snapshot = slimCurrentPrice(priceRaw.output || {});
        const technical = analyzeTechnical(chartRaw);
        const supply = analyzeSupply(investorRaw.output || [], dailyRaw.output || []);
        const finance = buildFinance(annualIncomeRaw.output || [], quarterIncomeRaw.output || [], ratioRaw.output || []);

        let dart = null;
        if (corp) {
          if (!hasBinding(env, "DART_API_KEY")) {
            dart = { ok: false, error: "DART_API_KEY is not configured" };
          } else if (!/^\d{8}$/.test(corp)) {
            dart = { ok: false, error: "DART 기업고유번호는 8자리 숫자여야 합니다." };
          } else {
            try {
              const company = await dartCompany(env, corp);
              dart = {
                ok: company.status === "000",
                company: slimDartCompany(company),
                message: company.message || null,
              };
            } catch (error) {
              dart = { ok: false, error: error?.message || String(error) };
            }
          }
        }

        return json({
          ok: true,
          version: APP_VERSION,
          code,
          analyzedAt: new Date().toISOString(),
          snapshot,
          technical,
          supply,
          finance,
          dart,
          sourceErrors,
          partial: sourceErrors.length > 0,
          implementation: {
            industry: "종목 업종명 표시. 업종지수 파도 스캐너는 다음 단계에서 추가",
            financial: "KIS 연간 3개년/최근 4개 분기 + 유보율/부채비율",
            supply: "외국인·기관 누적 순매수와 지속성 가점",
            technical: "일봉 + MA20/60/120 + 현재 위치",
            timing: "60~120일선 구간 및 MA120 이탈 여부 표시",
          },
          warning: "기업 선별을 돕는 분석 도구이며 자동주문 기능은 포함하지 않습니다.",
        });
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (error) {
      return json({ ok: false, error: error?.message || String(error) }, error?.status || 500);
    }
  },
};

async function safeSource(label, fn) {
  try {
    return { ok: true, label, value: await fn(), error: null };
  } catch (error) {
    return { ok: false, label, value: null, error: error?.message || String(error) };
  }
}

function bindingValue(env, name) {
  const value = env?.[name];
  if (typeof value === "string") return value.trim();
  return value || null;
}

function hasBinding(env, name) {
  return Boolean(bindingValue(env, name));
}

function assertAccess(request, env) {
  const expected = bindingValue(env, "APP_ACCESS_KEY");
  if (!expected) return;
  const supplied = request.headers.get("x-app-key") || "";
  if (supplied !== expected) {
    const error = new Error("개인 접속키가 없거나 올바르지 않습니다.");
    error.status = 401;
    throw error;
  }
}

function requireEnv(env, keys) {
  const missing = keys.filter((k) => !hasBinding(env, k));
  if (missing.length) {
    const error = new Error(
      `현재 실행 중인 Worker가 Cloudflare 변수/시크릿을 감지하지 못했습니다: ${missing.join(", ")}. ` +
      "Settings > Variables and Secrets에서 값을 확인한 뒤 반드시 Deploy를 눌러 반영하세요."
    );
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
    const error = new Error("종목코드는 6자리 숫자여야 합니다. 예: 005930");
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
    throw new Error(`${label}가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status}): ${text.slice(0, 220)}`);
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}: ${data?.msg1 || data?.message || JSON.stringify(data).slice(0, 220)}`);
  }
  return data;
}

async function kisToken(env) {
  const now = Date.now();
  if (kisTokenCache && kisTokenCache.expiresAt > now + 60_000) return kisTokenCache.token;
  if (kisTokenPromise) return kisTokenPromise;

  kisTokenPromise = (async () => {
    const data = await fetchJson(`${KIS_BASE}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: bindingValue(env, "KIS_APP_KEY"),
        appsecret: bindingValue(env, "KIS_APP_SECRET"),
      }),
    }, "KIS OAuth");

    if (!data.access_token) {
      throw new Error(`KIS 토큰 발급 실패: ${data.error_description || data.msg1 || "access_token 없음"}`);
    }

    const expiresIn = Number(data.expires_in || 21_600);
    kisTokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(300, expiresIn - 120) * 1000,
    };
    return data.access_token;
  })();

  try {
    return await kisTokenPromise;
  } finally {
    kisTokenPromise = null;
  }
}

async function kisGet(env, path, trId, params) {
  const token = await kisToken(env);
  const qs = new URLSearchParams(params);
  const url = `${KIS_BASE}${path}?${qs.toString()}`;
  const data = await fetchJson(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
      appkey: bindingValue(env, "KIS_APP_KEY"),
      appsecret: bindingValue(env, "KIS_APP_SECRET"),
      tr_id: trId,
      custtype: "P",
    },
  }, `KIS ${path}`);

  if (data.rt_cd && data.rt_cd !== "0") {
    throw new Error(`KIS 오류 ${data.msg_cd || data.rt_cd}: ${data.msg1 || "unknown error"}`);
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

async function kisIncomeStatement(env, code, divCode) {
  return kisGet(env, "/uapi/domestic-stock/v1/finance/income-statement", "FHKST66430200", {
    FID_DIV_CLS_CODE: divCode,
    fid_cond_mrkt_div_code: "J",
    fid_input_iscd: code,
  });
}

async function kisFinancialRatio(env, code, divCode) {
  return kisGet(env, "/uapi/domestic-stock/v1/finance/financial-ratio", "FHKST66430300", {
    FID_DIV_CLS_CODE: divCode,
    fid_cond_mrkt_div_code: "J",
    fid_input_iscd: code,
  });
}

async function kisDailyChart(env, code, targetRows = 190) {
  const collected = new Map();
  let end = new Date();

  for (let page = 0; page < 4 && collected.size < targetRows; page++) {
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
    const error = new Error("DART 기업고유번호는 8자리 숫자여야 합니다. 예: 00126380");
    error.status = 400;
    throw error;
  }
  const qs = new URLSearchParams({ crtfc_key: bindingValue(env, "DART_API_KEY"), corp_code: corpCode });
  return fetchJson(`${DART_BASE}/company.json?${qs}`, {}, "OpenDART company");
}

async function krxKospiDaily(env, basDd) {
  if (!/^\d{8}$/.test(String(basDd))) {
    const error = new Error("KRX 날짜는 YYYYMMDD 형식이어야 합니다.");
    error.status = 400;
    throw error;
  }
  return fetchJson(`${KRX_BASE}/sto/stk_bydd_trd?basDd=${basDd}`, {
    headers: { AUTH_KEY: bindingValue(env, "KRX_AUTH_KEY") },
  }, "KRX KOSPI daily");
}

async function ecosKeyStatistics(env, count = 5) {
  return fetchJson(`${ECOS_BASE}/KeyStatisticList/${encodeURIComponent(bindingValue(env, "ECOS_API_KEY"))}/json/kr/1/${count}`, {}, "ECOS KeyStatisticList");
}

function analyzeTechnical(rows) {
  const clean = (rows || [])
    .map((r) => ({
      date: r.stck_bsop_date,
      close: num(r.stck_clpr),
      open: num(r.stck_oprc),
      high: num(r.stck_hgpr),
      low: num(r.stck_lwpr),
      volume: num(r.acml_vol),
    }))
    .filter((r) => r.date && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (clean.length < 120) {
    return { ok: false, rows: clean.length, message: "MA120 분석을 위해 최소 120거래일이 필요합니다.", series: [] };
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

  const series = clean.map((row, idx) => {
    const subset = closes.slice(0, idx + 1);
    return {
      date: row.date,
      close: round(row.close),
      ma20: subset.length >= 20 ? round(sma(subset, 20)) : null,
      ma60: subset.length >= 60 ? round(sma(subset, 60)) : null,
      ma120: subset.length >= 120 ? round(sma(subset, 120)) : null,
      volume: round(row.volume),
    };
  }).slice(-180);

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
    series,
    rule: "현재가 > MA20 > MA60 > MA120이며 MA60·MA120이 10거래일 전보다 상승하면 정배열 상승으로 판정",
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
      foreignExhaustion: numOrNull(r.hts_frgn_ehrt),
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
  const foreignHoldingRateDelta = Number.isFinite(newestRate) && Number.isFinite(oldestRate)
    ? round(newestRate - oldestRate, 2)
    : null;

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

  let label = "혼조/약함";
  if (score >= 80) label = "강한 매집";
  else if (score >= 60) label = "매집 우위";
  else if (score >= 40) label = "관찰";

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
      holdingTrendMethod: "기관 직접 보유량 시계열 대신 누적 순매수를 대용지표로 사용",
    },
    joint: {
      bothPositiveDays20: bothPositive20,
      bothNetPositive20d: f20 > 0 && i20 > 0,
    },
    daily: rows.slice(0, 30).reverse(),
    scoreRule: "하루 순매수보다 5·20·30일 누적, 순매수 지속일수, 외국인 보유비율 상승을 더 높게 평가",
  };
}

function buildFinance(annualRows, quarterRows, ratioRows) {
  const annual = normalizeIncomeRows(annualRows)
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 3);

  const quarterCum = normalizeIncomeRows(quarterRows)
    .sort((a, b) => a.period.localeCompare(b.period));
  const annualAll = normalizeIncomeRows(annualRows)
    .sort((a, b) => a.period.localeCompare(b.period));

  const quarterStandalone = toStandaloneQuarters(quarterCum, annualAll)
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 4);

  const ratios = (ratioRows || [])
    .map((r) => ({
      period: normalizePeriod(r.stac_yymm),
      reserveRatio: numOrNull(r.rsrv_rate),
      debtRatio: numOrNull(r.lblt_rate),
      roe: numOrNull(r.roe_val),
      revenueGrowth: numOrNull(r.grs),
      operatingIncomeGrowth: numOrNull(r.bsop_prfi_inrt),
      netIncomeGrowth: numOrNull(r.ntin_inrt),
      eps: numOrNull(r.eps),
      bps: numOrNull(r.bps),
    }))
    .filter((r) => r.period)
    .sort((a, b) => b.period.localeCompare(a.period));

  return {
    annual,
    quarterly: quarterStandalone,
    ratios: ratios.slice(0, 3),
    latestRatio: ratios[0] || null,
    amountUnit: "KIS 손익계산서 원자료 단위",
    note: "KIS 분기 손익은 연간 누적값으로 제공되므로 동일 연도 누적값의 차이를 계산해 개별 분기로 변환했습니다. 4분기는 연간값과 3분기 누적값 차이로 계산합니다.",
  };
}

function normalizeIncomeRows(rows) {
  return (rows || [])
    .map((r) => ({
      period: normalizePeriod(r.stac_yymm),
      revenue: numOrNull(r.sale_account),
      operatingIncome: numOrNull(r.bsop_prti),
      netIncome: numOrNull(r.thtr_ntin),
    }))
    .filter((r) => r.period && r.revenue !== null);
}

function normalizePeriod(v) {
  const s = String(v || "").replace(/[^0-9]/g, "");
  return /^\d{6}$/.test(s) ? s : null;
}

function toStandaloneQuarters(cumulativeRows, annualRows) {
  const byPeriod = new Map();
  for (const row of cumulativeRows) byPeriod.set(row.period, row);
  for (const row of annualRows) {
    if (row.period?.endsWith("12") && !byPeriod.has(row.period)) byPeriod.set(row.period, row);
  }

  const periods = [...byPeriod.keys()].sort();
  const result = [];
  for (const period of periods) {
    const year = period.slice(0, 4);
    const month = Number(period.slice(4, 6));
    if (![3, 6, 9, 12].includes(month)) continue;
    const current = byPeriod.get(period);
    const prevMonth = month - 3;
    const prevPeriod = prevMonth > 0 ? `${year}${String(prevMonth).padStart(2, "0")}` : null;
    const prev = prevPeriod ? byPeriod.get(prevPeriod) : null;

    const isQ1 = month === 3;
    const revenue = isQ1 ? current.revenue : diffMetric(current.revenue, prev?.revenue);
    const operatingIncome = isQ1 ? current.operatingIncome : diffMetric(current.operatingIncome, prev?.operatingIncome);
    const netIncome = isQ1 ? current.netIncome : diffMetric(current.netIncome, prev?.netIncome);

    if (revenue === null && operatingIncome === null) continue;
    result.push({
      period,
      label: `${year} Q${month / 3}`,
      revenue,
      operatingIncome,
      netIncome,
      convertedFromCumulative: !isQ1,
    });
  }
  return result;
}

function diffMetric(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a - b;
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

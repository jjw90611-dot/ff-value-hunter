const KIS_BASE = "https://openapi.koreainvestment.com:9443";
const DART_BASE = "https://opendart.fss.or.kr/api";
const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";
const ECOS_BASE = "https://ecos.bok.or.kr/api";
const APP_VERSION = "0.4.0";
const MASTER_BASE = "https://new.real.download.dws.co.kr/common/master";
const UNIVERSE_CACHE_URL = "https://ff-value-hunter-cache.local/stock-universe-v4";
const SECTOR_TREND_CACHE_PREFIX = "https://ff-value-hunter-cache.local/sector-trend-v4/";
const KIS_MIN_INTERVAL_MS = 450;
const KIS_TOKEN_CACHE_URL = "https://ff-value-hunter-token-cache.local/kis-access-token-v3";

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
let kisRequestChain = Promise.resolve();
let kisLastRequestAt = 0;

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
        try {
          const data = await dartCompany(env, url.searchParams.get("corp") || "00126380");
          return json({
            ok: true,
            available: data.status === "000",
            provider: "OpenDART",
            sample: slimDartCompany(data),
            rawStatus: data.status,
            message: data.message || (data.status === "000" ? "인증 정상" : "DART 응답 확인 필요"),
          });
        } catch (error) {
          return json({
            ok: true,
            available: false,
            provider: "OpenDART",
            state: "dart-unavailable",
            message: dartFriendlyError(error),
          });
        }
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
        try {
          const data = await krxKospiDaily(env, basDd);
          return json({
            ok: true,
            available: Array.isArray(data.OutBlock_1),
            provider: "KRX",
            date: basDd,
            rows: data.OutBlock_1?.length || 0,
            sample: data.OutBlock_1?.[0] || null,
          });
        } catch (error) {
          const msg = safeErrorMessage(error);
          if (/401|Unauthorized API Call/i.test(msg)) {
            return json({
              ok: true,
              available: false,
              provider: "KRX",
              state: "approval-required",
              message: "인증키는 감지됐지만 ‘유가증권 일별매매정보’ API 활용승인이 없거나 아직 반영되지 않았습니다. KRX는 현재 단일 종목 분석에는 필수가 아닙니다.",
            });
          }
          return json({ ok: true, available: false, provider: "KRX", state: "unavailable", message: msg });
        }
      }

      if (url.pathname === "/api/test/ecos") {
        requireEnv(env, ["ECOS_API_KEY"]);
        const data = await ecosKeyStatistics(env, 5);
        const rows = data?.KeyStatisticList?.row || [];
        return json({ ok: rows.length > 0, provider: "ECOS", rows: rows.length, sample: rows.slice(0, 5) });
      }

      if (url.pathname === "/api/sectors") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const [kospi, kosdaq] = await Promise.all([
          safeSource("KOSPI 업종", () => kisIndexCategory(env, "0001", "K")),
          safeSource("KOSDAQ 업종", () => kisIndexCategory(env, "1001", "Q")),
        ]);
        const sectors = [
          ...normalizeSectorList(kospi.value, "KOSPI", "K"),
          ...normalizeSectorList(kosdaq.value, "KOSDAQ", "Q"),
        ].filter((item) => item.name && item.code && isUsefulSector(item));
        return json({
          ok: true,
          version: APP_VERSION,
          sectors: dedupeSectors(sectors).sort((a, b) => (b.dayPct || 0) - (a.dayPct || 0)),
          errors: [kospi, kosdaq].filter((x) => !x.ok).map((x) => ({ label: x.label, error: x.error })),
          note: "KIS 국내업종 구분별전체시세를 기준으로 한 공식 업종 목록입니다. 테마주는 별도 데이터가 아니라 업종/섹터 중심으로 구성합니다.",
        });
      }

      if (url.pathname === "/api/sector-trend") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeSectorCode(url.searchParams.get("code"));
        const market = String(url.searchParams.get("market") || "K").toUpperCase();
        const cacheKey = `${SECTOR_TREND_CACHE_PREFIX}${market}-${code}`;
        const cached = await cacheJsonGet(cacheKey);
        if (cached) return json({ ...cached, cached: true });
        const raw = await kisIndexDaily(env, code);
        const trend = analyzeSectorTrend(raw?.output2 || raw?.output || []);
        const payload = { ok: true, code, market, trend, cached: false };
        await cacheJsonPut(cacheKey, payload, 60 * 60 * 4);
        return json(payload);
      }

      if (url.pathname === "/api/sector-members") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeSectorCode(url.searchParams.get("code"));
        const name = String(url.searchParams.get("name") || "").trim();
        const market = String(url.searchParams.get("market") || "ALL").toUpperCase();
        const universe = await loadStockUniverse();
        const members = selectSectorMembers(universe, code, name, market)
          .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
        return json({
          ok: true,
          sector: { code, name, market },
          total: members.length,
          members: members.slice(0, 300),
          note: "한국투자증권 공식 KOSPI/KOSDAQ 종목 마스터의 업종 대·중·소분류와 KRX 섹터 플래그를 사용합니다.",
        });
      }

      if (url.pathname === "/api/rank-stocks") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const codes = String(url.searchParams.get("codes") || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 6)
          .map(normalizeCode);
        if (!codes.length) {
          const error = new Error("분석할 종목코드가 없습니다.");
          error.status = 400;
          throw error;
        }
        const items = [];
        for (const code of codes) {
          const annualRes = await safeSource("연간 손익", () => kisIncomeStatement(env, code, "0"));
          const ratioRes = await safeSource("재무비율", () => kisFinancialRatio(env, code, "0"));
          items.push(buildStockRankItem(code, annualRes.value?.output || [], ratioRes.value?.output || [], [annualRes, ratioRes]));
        }
        return json({ ok: true, items });
      }

      if (url.pathname === "/api/analyze") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeCode(url.searchParams.get("code") || "005930");
        const corp = (url.searchParams.get("corp") || "").trim();

        // KIS는 호출 제한이 있으므로 v0.4부터 병렬 호출을 금지하고 순차 호출합니다.
        const stockInfoRes = await safeSource("기업명·업종", () => kisSearchStockInfo(env, code));
        const priceRes = await safeSource("현재가", () => kisCurrentPrice(env, code));
        if (!priceRes.ok) {
          throw new Error(`KIS 현재가 조회 실패: ${priceRes.error}`);
        }
        const investorRes = await safeSource("외국인·기관 수급", () => kisInvestor(env, code));
        const dailyRes = await safeSource("외국인 보유비율", () => kisDailyPrice30(env, code));
        const annualRes = await safeSource("연간 손익계산서", () => kisIncomeStatement(env, code, "0"));
        const quarterRes = await safeSource("분기 손익계산서", () => kisIncomeStatement(env, code, "1"));
        const ratioRes = await safeSource("재무비율", () => kisFinancialRatio(env, code, "0"));
        const chartRes = await safeSource("일봉 차트", () => kisDailyChart(env, code, 140));

        const calls = [stockInfoRes, priceRes, investorRes, dailyRes, annualRes, quarterRes, ratioRes, chartRes];
        const sourceErrors = calls
          .filter((item) => !item.ok)
          .map((item) => ({ label: item.label, error: item.error }));

        const stockInfoRaw = stockInfoRes.value || {};
        const priceRaw = priceRes.value || {};
        const investorRaw = investorRes.value || {};
        const dailyRaw = dailyRes.value || {};
        const annualIncomeRaw = annualRes.value || {};
        const quarterIncomeRaw = quarterRes.value || {};
        const ratioRaw = ratioRes.value || {};
        const chartRaw = chartRes.value || [];

        const identity = buildIdentity(stockInfoRaw.output || {}, priceRaw.output || {}, code);
        const snapshot = slimCurrentPrice(priceRaw.output || {});
        if (!snapshot.name) snapshot.name = identity.name;
        if (!snapshot.industry) snapshot.industry = identity.sector || identity.industryStandard;
        const technical = analyzeTechnical(chartRaw);
        const supply = analyzeSupply(investorRaw.output || [], dailyRaw.output || []);
        const finance = buildFinance(
          annualIncomeRaw.output || [],
          quarterIncomeRaw.output || [],
          ratioRaw.output || [],
          identity.fiscalMonth || snapshot.fiscalMonth || "12"
        );

        let dart = null;
        if (corp) {
          if (!hasBinding(env, "DART_API_KEY")) {
            dart = { ok: false, error: "DART_API_KEY가 설정되지 않았습니다." };
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
              dart = { ok: false, error: dartFriendlyError(error) };
            }
          }
        }

        return json({
          ok: true,
          version: APP_VERSION,
          code,
          analyzedAt: new Date().toISOString(),
          identity,
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
      return json({ ok: false, error: safeErrorMessage(error) }, error?.status || 500);
    }
  },
};

async function safeSource(label, fn) {
  try {
    return { ok: true, label, value: await fn(), error: null };
  } catch (error) {
    return { ok: false, label, value: null, error: safeErrorMessage(error) };
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
  let res;
  try {
    res = await fetch(url, options);
  } catch (error) {
    throw new Error(`${label} 네트워크 오류: ${safeErrorMessage(error)}`);
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label}가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status}): ${sanitizeText(text.slice(0, 220))}`);
  }
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}: ${sanitizeText(data?.msg1 || data?.error_description || data?.message || JSON.stringify(data).slice(0, 220))}`);
  }
  return data;
}

async function readPersistedKisToken() {
  try {
    if (typeof caches === "undefined" || !caches.default) return null;
    const cached = await caches.default.match(new Request(KIS_TOKEN_CACHE_URL));
    if (!cached) return null;
    const data = await cached.json();
    if (!data?.token || !Number.isFinite(Number(data?.expiresAt))) return null;
    if (Number(data.expiresAt) <= Date.now() + 120_000) return null;
    return { token: data.token, expiresAt: Number(data.expiresAt) };
  } catch {
    return null;
  }
}

async function persistKisToken(token, expiresAt) {
  try {
    if (typeof caches === "undefined" || !caches.default) return;
    const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000));
    const response = new Response(JSON.stringify({ token, expiresAt }), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${ttl}`,
      },
    });
    await caches.default.put(new Request(KIS_TOKEN_CACHE_URL), response);
  } catch {
    // Cache API를 사용할 수 없는 환경에서는 모듈 메모리 캐시만 사용합니다.
  }
}

async function kisToken(env) {
  const now = Date.now();
  if (kisTokenCache && kisTokenCache.expiresAt > now + 120_000) return kisTokenCache.token;
  if (kisTokenPromise) return kisTokenPromise;

  kisTokenPromise = (async () => {
    const persisted = await readPersistedKisToken();
    if (persisted) {
      kisTokenCache = persisted;
      return persisted.token;
    }

    let data;
    try {
      data = await fetchJson(`${KIS_BASE}/oauth2/tokenP`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: bindingValue(env, "KIS_APP_KEY"),
          appsecret: bindingValue(env, "KIS_APP_SECRET"),
        }),
      }, "KIS OAuth");
    } catch (error) {
      const msg = safeErrorMessage(error);
      if (/EGW00133|1분당 1회|접근토큰 발급 잠시 후/i.test(msg)) {
        throw new Error("KIS 접근토큰 발급은 1분당 1회 제한이 있습니다. v0.4은 발급 토큰을 재사용하도록 보완했습니다. 직전에 토큰을 발급했다면 약 60초 후 한 번만 다시 시도하세요.");
      }
      throw error;
    }

    if (!data.access_token) {
      throw new Error(`KIS 토큰 발급 실패: ${sanitizeText(data.error_description || data.msg1 || "access_token 없음")}`);
    }

    const expiresIn = Number(data.expires_in || 82_800); // 공식 샘플은 접근토큰 유효기간을 1일로 관리
    const expiresAt = Date.now() + Math.max(600, Math.min(expiresIn - 180, 82_800)) * 1000;
    kisTokenCache = { token: data.access_token, expiresAt };
    await persistKisToken(data.access_token, expiresAt);
    return data.access_token;
  })();

  try {
    return await kisTokenPromise;
  } finally {
    kisTokenPromise = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function kisSchedule(task) {
  const run = kisRequestChain.then(async () => {
    const wait = Math.max(0, KIS_MIN_INTERVAL_MS - (Date.now() - kisLastRequestAt));
    if (wait) await sleep(wait);
    kisLastRequestAt = Date.now();
    return task();
  });
  kisRequestChain = run.catch(() => null);
  return run;
}

function isKisRateLimitMessage(message) {
  return /초당 거래건수를 초과|EGW00201|rate.?limit/i.test(String(message || ""));
}

async function kisGet(env, path, trId, params) {
  const token = await kisToken(env);
  const qs = new URLSearchParams(params);
  const url = `${KIS_BASE}${path}?${qs.toString()}`;

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await kisSchedule(() => fetchJson(url, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          accept: "application/json,text/plain,*/*",
          authorization: `Bearer ${token}`,
          appkey: bindingValue(env, "KIS_APP_KEY"),
          appsecret: bindingValue(env, "KIS_APP_SECRET"),
          tr_id: trId,
          custtype: "P",
        },
      }, `KIS ${path}`));

      if (data.rt_cd && data.rt_cd !== "0") {
        throw new Error(`KIS 오류 ${data.msg_cd || data.rt_cd}: ${sanitizeText(data.msg1 || "unknown error")}`);
      }
      return data;
    } catch (error) {
      lastError = error;
      if (!isKisRateLimitMessage(safeErrorMessage(error)) || attempt >= 2) break;
      await sleep(1100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function kisSearchStockInfo(env, code) {
  return kisGet(env, "/uapi/domestic-stock/v1/quotations/search-stock-info", "CTPF1002R", {
    PRDT_TYPE_CD: "300",
    PDNO: code,
  });
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


async function kisIndexCategory(env, inputCode, marketCls) {
  return kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-index-category-price", "FHPUP02140000", {
    FID_COND_MRKT_DIV_CODE: "U",
    FID_INPUT_ISCD: inputCode,
    FID_COND_SCR_DIV_CODE: "20214",
    FID_MRKT_CLS_CODE: marketCls,
    FID_BLNG_CLS_CODE: "0",
  });
}

async function kisIndexDaily(env, sectorCode) {
  // 기간별 업종시세 API는 명시적 시작/종료일을 받을 수 있어 장기 이동평균 계산에 더 적합합니다.
  // 응답 건수 제한에 대비해 두 구간으로 나눠 받고 날짜로 합칩니다.
  const end2 = new Date();
  const start2 = new Date(end2);
  start2.setUTCDate(start2.getUTCDate() - 220);
  const end1 = new Date(start2);
  end1.setUTCDate(end1.getUTCDate() - 1);
  const start1 = new Date(end1);
  start1.setUTCDate(start1.getUTCDate() - 260);

  const first = await kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice", "FHKUP03500100", {
    FID_COND_MRKT_DIV_CODE: "U",
    FID_INPUT_ISCD: sectorCode,
    FID_INPUT_DATE_1: yyyymmdd(start1),
    FID_INPUT_DATE_2: yyyymmdd(end1),
    FID_PERIOD_DIV_CODE: "D",
  });
  const second = await kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice", "FHKUP03500100", {
    FID_COND_MRKT_DIV_CODE: "U",
    FID_INPUT_ISCD: sectorCode,
    FID_INPUT_DATE_1: yyyymmdd(start2),
    FID_INPUT_DATE_2: yyyymmdd(end2),
    FID_PERIOD_DIV_CODE: "D",
  });

  const byDate = new Map();
  for (const row of [...(first?.output2 || []), ...(second?.output2 || [])]) {
    const date = String(row.stck_bsop_date || "");
    if (date) byDate.set(date, row);
  }
  return {
    rt_cd: second?.rt_cd || first?.rt_cd || "0",
    msg1: second?.msg1 || first?.msg1 || "",
    output1: second?.output1 || first?.output1 || null,
    output2: [...byDate.values()],
  };
}

function normalizeSectorList(data, marketName, marketCode) {
  const rows = data?.output2 || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    id: `${marketCode}:${String(r.bstp_cls_code || "").trim()}`,
    code: String(r.bstp_cls_code || "").trim(),
    name: String(r.hts_kor_isnm || "").trim(),
    market: marketName,
    marketCode,
    current: numOrNull(r.bstp_nmix_prpr),
    dayChange: numOrNull(r.bstp_nmix_prdy_vrss),
    dayPct: numOrNull(r.bstp_nmix_prdy_ctrt),
    volume: numOrNull(r.acml_vol),
    tradedAmount: numOrNull(r.acml_tr_pbmn),
  }));
}

function isUsefulSector(item) {
  const name = String(item?.name || "").replace(/\s+/g, "");
  const code = normalizeIndustryCode(item?.code);
  if (!name || !code) return false;
  // 종합지수/규모지수는 산업 선택 화면에서 제외하고 실제 업종 위주로 보여줍니다.
  if (/^(종합|대형주|중형주|소형주|우선주|코스피|코스닥|KOSPI|KOSDAQ|코스피200|코스닥150)$/i.test(name)) return false;
  if (["1", "2", "3", "4", "1001", "2001", "3003"].includes(code)) return false;
  return true;
}

function dedupeSectors(items) {
  const seen = new Map();
  for (const item of items || []) {
    const key = `${item.marketCode}:${normalizeIndustryCode(item.code)}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function normalizeSectorCode(value) {
  const code = String(value || "").trim();
  if (!/^\d{1,4}$/.test(code)) {
    const error = new Error("업종코드는 1~4자리 숫자여야 합니다.");
    error.status = 400;
    throw error;
  }
  return code.padStart(4, "0");
}

function normalizeIndustryCode(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const n = s.replace(/^0+/, "");
  return n || "0";
}

function analyzeSectorTrend(rows) {
  const clean = (rows || [])
    .map((r) => ({
      date: String(r.stck_bsop_date || ""),
      close: numOrNull(r.bstp_nmix_prpr),
      volume: numOrNull(r.acml_vol),
    }))
    .filter((r) => r.date && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (clean.length < 20) {
    return { ok: false, rows: clean.length, score: 0, label: "데이터 부족", series: clean };
  }

  const closes = clean.map((r) => r.close);
  const last = closes[closes.length - 1];
  const ma20 = closes.length >= 20 ? sma(closes, 20) : null;
  const ma60 = closes.length >= 60 ? sma(closes, 60) : null;
  const ma120 = closes.length >= 120 ? sma(closes, 120) : null;
  const ma20Ago10 = closes.length >= 30 ? sma(closes.slice(0, -10), 20) : null;
  const ma60Ago10 = closes.length >= 70 ? sma(closes.slice(0, -10), 60) : null;
  const ma120Ago10 = closes.length >= 130 ? sma(closes.slice(0, -10), 120) : null;
  const ret20 = closes.length > 20 ? pct(last, closes[closes.length - 21]) : null;
  const ret60 = closes.length > 60 ? pct(last, closes[closes.length - 61]) : null;
  const ret120 = closes.length > 120 ? pct(last, closes[closes.length - 121]) : null;

  let score = 0;
  if (Number.isFinite(ma20) && last > ma20) score += 15;
  if (Number.isFinite(ma20) && Number.isFinite(ma60) && ma20 > ma60) score += 20;
  if (Number.isFinite(ma60) && Number.isFinite(ma120) && ma60 > ma120) score += 20;
  if (Number.isFinite(ma20Ago10) && ma20 > ma20Ago10) score += 10;
  if (Number.isFinite(ma60Ago10) && ma60 > ma60Ago10) score += 15;
  if (Number.isFinite(ma120Ago10) && ma120 > ma120Ago10) score += 10;
  if (Number.isFinite(ret20) && ret20 > 0) score += 5;
  if (Number.isFinite(ret60) && ret60 > 0) score += 5;
  score = Math.min(100, score);

  const fullAligned = Number.isFinite(ma120)
    ? last > ma20 && ma20 > ma60 && ma60 > ma120
    : Number.isFinite(ma60) && last > ma20 && ma20 > ma60;
  const rising = (ma20Ago10 === null || ma20 > ma20Ago10) && (ma60Ago10 === null || ma60 > ma60Ago10) && (ma120Ago10 === null || ma120 > ma120Ago10);
  let label = "혼조/약세";
  if (score >= 85 && fullAligned && rising) label = "강한 정배열 상승";
  else if (score >= 70) label = "상승추세";
  else if (score >= 55) label = "상승 전환/관찰";

  return {
    ok: true,
    rows: clean.length,
    date: clean.at(-1)?.date || null,
    score,
    label,
    close: round(last, 2),
    ma20: Number.isFinite(ma20) ? round(ma20, 2) : null,
    ma60: Number.isFinite(ma60) ? round(ma60, 2) : null,
    ma120: Number.isFinite(ma120) ? round(ma120, 2) : null,
    ma20Slope10dPct: Number.isFinite(ma20Ago10) ? pct(ma20, ma20Ago10) : null,
    ma60Slope10dPct: Number.isFinite(ma60Ago10) ? pct(ma60, ma60Ago10) : null,
    ma120Slope10dPct: Number.isFinite(ma120Ago10) ? pct(ma120, ma120Ago10) : null,
    return20d: Number.isFinite(ret20) ? round(ret20, 2) : null,
    return60d: Number.isFinite(ret60) ? round(ret60, 2) : null,
    return120d: Number.isFinite(ret120) ? round(ret120, 2) : null,
    aligned: fullAligned,
    rising,
    wavePass: fullAligned && rising,
    series: clean.slice(-140).map((r, idx, arr) => {
      const globalIdx = clean.length - arr.length + idx;
      const subset = closes.slice(0, globalIdx + 1);
      return {
        date: r.date,
        close: round(r.close, 2),
        ma20: subset.length >= 20 ? round(sma(subset, 20), 2) : null,
        ma60: subset.length >= 60 ? round(sma(subset, 60), 2) : null,
        ma120: subset.length >= 120 ? round(sma(subset, 120), 2) : null,
      };
    }),
    rule: "현재 지수와 MA20·60·120 정배열, 각 이동평균선 기울기, 20·60일 수익률을 종합해 지속 상승 점수를 계산",
  };
}

async function cacheJsonGet(url) {
  try {
    if (typeof caches === "undefined" || !caches.default) return null;
    const hit = await caches.default.match(new Request(url));
    return hit ? await hit.json() : null;
  } catch {
    return null;
  }
}

async function cacheJsonPut(url, data, ttlSeconds) {
  try {
    if (typeof caches === "undefined" || !caches.default) return;
    await caches.default.put(new Request(url), new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttlSeconds}` },
    }));
  } catch {
    // 캐시 실패는 기능 실패로 보지 않습니다.
  }
}

let universeMemoryCache = null;
async function loadStockUniverse() {
  if (universeMemoryCache?.length) return universeMemoryCache;
  const cached = await cacheJsonGet(UNIVERSE_CACHE_URL);
  if (Array.isArray(cached?.items) && cached.items.length) {
    universeMemoryCache = cached.items;
    return universeMemoryCache;
  }

  const [kospi, kosdaq] = await Promise.all([
    fetchMasterMarket("kospi"),
    fetchMasterMarket("kosdaq"),
  ]);
  universeMemoryCache = [...kospi, ...kosdaq];
  await cacheJsonPut(UNIVERSE_CACHE_URL, { items: universeMemoryCache, updatedAt: new Date().toISOString() }, 60 * 60 * 12);
  return universeMemoryCache;
}

async function fetchMasterMarket(market) {
  const isKospi = market === "kospi";
  const url = `${MASTER_BASE}/${market}_code.mst.zip`;
  const res = await fetch(url, { headers: { "user-agent": "FF-Value-Hunter/0.4" } });
  if (!res.ok) throw new Error(`KIS ${market.toUpperCase()} 종목 마스터 다운로드 실패 HTTP ${res.status}`);
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  const mstBytes = await unzipMstFile(zipBytes);
  let decoder;
  try { decoder = new TextDecoder("euc-kr"); } catch { decoder = new TextDecoder("utf-8"); }
  const text = decoder.decode(mstBytes);
  return parseMasterText(text, isKospi ? "KOSPI" : "KOSDAQ");
}

async function unzipMstFile(bytes) {
  // 외부 ZIP 라이브러리 없이 Worker의 DecompressionStream(deflate-raw)을 사용합니다.
  // 중앙 디렉터리를 읽어 .mst 엔트리 하나만 해제하므로 번들/빌드 의존성을 줄입니다.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readU16 = (offset) => view.getUint16(offset, true);
  const readU32 = (offset) => view.getUint32(offset, true);
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= floor; i--) {
    if (readU32(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("KIS 종목 마스터 ZIP의 중앙 디렉터리를 찾지 못했습니다.");

  const totalEntries = readU16(eocd + 10);
  let pos = readU32(eocd + 16);
  const utf8 = new TextDecoder("utf-8");

  for (let entry = 0; entry < totalEntries; entry++) {
    if (pos + 46 > bytes.length || readU32(pos) !== CENTRAL) break;
    const method = readU16(pos + 10);
    const compressedSize = readU32(pos + 20);
    const fileNameLength = readU16(pos + 28);
    const extraLength = readU16(pos + 30);
    const commentLength = readU16(pos + 32);
    const localOffset = readU32(pos + 42);
    const name = utf8.decode(bytes.slice(pos + 46, pos + 46 + fileNameLength));

    if (name.toLowerCase().endsWith(".mst")) {
      if (localOffset + 30 > bytes.length || readU32(localOffset) !== LOCAL) {
        throw new Error("KIS 종목 마스터 ZIP의 로컬 헤더가 손상되었습니다.");
      }
      const localNameLength = readU16(localOffset + 26);
      const localExtraLength = readU16(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed;
      if (method !== 8) throw new Error(`지원하지 않는 KIS 종목 마스터 ZIP 압축방식: ${method}`);
      const decompressed = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(decompressed).arrayBuffer());
    }
    pos += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error("KIS 종목 마스터 ZIP 안에 .mst 파일이 없습니다.");
}

const KOSPI_WIDTHS = [
  2,1,4,4,4,
  1,1,1,1,1,
  1,1,1,1,1,
  1,1,1,1,1,
  1,1,1,1,1,
  1,1,1,1,1,
  1,9,5,5,1,
  1,1,2,1,1,
  1,2,2,2,3,
  1,3,12,12,8,
  15,21,2,7,1,
  1,1,1,1,9,
  9,9,5,9,8,
  9,3,1,1,1,
];
const KOSDAQ_WIDTHS = [
  2,1,
  4,4,4,1,1,
  1,1,1,1,1,
  1,1,1,1,1,
  1,1,1,1,1,
  1,1,1,1,9,
  5,5,1,1,1,
  2,1,1,1,2,
  2,2,3,1,3,
  12,12,8,15,21,
  2,7,1,1,1,
  1,9,9,9,5,
  9,8,9,3,1,
  1,1,
];

function parseMasterText(text, market) {
  const widths = market === "KOSPI" ? KOSPI_WIDTHS : KOSDAQ_WIDTHS;
  // 공식 파서는 줄바꿈을 포함해 KOSPI 228/KOSDAQ 222자를 자릅니다. 여기서는 줄바꿈 제거 후 처리하므로 실제 고정폭 합(227/221)을 사용합니다.
  const fixedLength = widths.reduce((sum, width) => sum + width, 0);
  const out = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length <= fixedLength) continue;
    const head = line.slice(0, line.length - fixedLength);
    const tail = line.slice(-fixedLength);
    const codeRaw = head.slice(0, 9).trim();
    const codeMatch = codeRaw.match(/\d{6}/);
    const code = codeMatch ? codeMatch[0] : "";
    if (!code) continue;
    const name = head.slice(21).trim();
    const fields = splitFixed(tail, widths);
    const item = market === "KOSPI" ? masterKospiItem(code, name, fields) : masterKosdaqItem(code, name, fields);
    if (!item) continue;
    out.push(item);
  }
  return out;
}

function splitFixed(text, widths) {
  const result = [];
  let pos = 0;
  for (const width of widths) {
    result.push(text.slice(pos, pos + width).trim());
    pos += width;
  }
  return result;
}

function masterKospiItem(code, name, f) {
  const item = baseMasterItem(code, name, "KOSPI", f[2], f[3], f[4], f[59], f[60], f[62], f[63], f[64], f[65]);
  item.flags = {
    auto: f[15], semiconductor: f[16], bio: f[17], bank: f[18], spac: f[19], energyChem: f[20], steel: f[21], mediaComm: f[23], construction: f[24], securities: f[26], ship: f[27], insurance: f[28], transport: f[29], etp: f[12],
  };
  item.risk = { suspended: f[34], liquidation: f[35], managed: f[36], warning: f[37], preferred: f[54] };
  return item;
}

function masterKosdaqItem(code, name, f) {
  const item = baseMasterItem(code, name, "KOSDAQ", f[2], f[3], f[4], f[53], f[54], f[56], f[57], f[58], f[59]);
  item.flags = {
    auto: f[10], semiconductor: f[11], bio: f[12], bank: f[13], spac: f[14], energyChem: f[15], steel: f[16], mediaComm: f[18], construction: f[19], securities: f[21], ship: f[22], insurance: f[23], transport: f[24], etp: f[8],
  };
  item.risk = { suspended: f[29], liquidation: f[30], managed: f[31], warning: f[32], preferred: f[49] };
  return item;
}

function baseMasterItem(code, name, market, large, medium, small, revenue, operatingIncome, netIncome, roe, refYm, marketCap) {
  return {
    code,
    name,
    market,
    industryLarge: String(large || "").trim(),
    industryMedium: String(medium || "").trim(),
    industrySmall: String(small || "").trim(),
    revenue: masterNumber(revenue),
    operatingIncome: masterNumber(operatingIncome),
    netIncome: masterNumber(netIncome),
    roe: masterNumber(roe, true),
    refYm: String(refYm || "").trim(),
    marketCap: masterNumber(marketCap),
  };
}

function masterNumber(value, decimal = false) {
  const s = String(value || "").replace(/,/g, "").trim();
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return decimal ? n / 100 : n;
}

function isYesFlag(value) {
  return ["Y", "1", "A"].includes(String(value || "").trim().toUpperCase());
}

function selectSectorMembers(universe, sectorCode, sectorName, marketCode) {
  const target = normalizeIndustryCode(sectorCode);
  const specialFlag = sectorSpecialFlag(sectorName);
  const matches = [];
  for (const item of universe || []) {
    if (marketCode === "K" && item.market !== "KOSPI") continue;
    if (marketCode === "Q" && item.market !== "KOSDAQ") continue;
    if (!isInvestmentCandidate(item)) continue;
    const exact = [item.industryLarge, item.industryMedium, item.industrySmall].some((x) => normalizeIndustryCode(x) === target);
    const special = specialFlag ? isYesFlag(item.flags?.[specialFlag]) : false;
    if (exact || special) matches.push(item);
  }
  const uniq = new Map();
  for (const m of matches) uniq.set(m.code, m);
  return [...uniq.values()];
}

function isInvestmentCandidate(item) {
  if (!/^\d{6}$/.test(item.code || "")) return false;
  if (isYesFlag(item.flags?.spac)) return false;
  if (String(item.flags?.etp || "").trim() && String(item.flags?.etp || "").trim() !== "0") return false;
  if (String(item.risk?.liquidation || "").trim() === "Y") return false;
  if (String(item.risk?.managed || "").trim() === "Y") return false;
  if (String(item.risk?.preferred || "").trim() && String(item.risk?.preferred || "").trim() !== "0") return false;
  return true;
}

function sectorSpecialFlag(name) {
  const n = String(name || "").replace(/\s+/g, "");
  if (/반도체/.test(n)) return "semiconductor";
  if (/자동차/.test(n)) return "auto";
  if (/바이오|의약|제약/.test(n)) return "bio";
  if (/은행/.test(n)) return "bank";
  if (/에너지|화학/.test(n)) return "energyChem";
  if (/철강/.test(n)) return "steel";
  if (/미디어|통신/.test(n)) return "mediaComm";
  if (/건설/.test(n)) return "construction";
  if (/증권/.test(n)) return "securities";
  if (/선박|조선/.test(n)) return "ship";
  if (/보험/.test(n)) return "insurance";
  if (/운송|운수/.test(n)) return "transport";
  return null;
}

function buildStockRankItem(code, annualRows, ratioRows, callResults = []) {
  const annual = normalizeIncomeRows(annualRows)
    .filter((r) => r.period)
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 3);
  const ratios = (ratioRows || []).map((r) => ({
    period: normalizePeriod(r.stac_yymm),
    reserveRatio: numOrNull(r.rsrv_rate),
    debtRatio: numOrNull(r.lblt_rate),
    roe: numOrNull(r.roe_val),
  })).filter((r) => r.period).sort((a, b) => b.period.localeCompare(a.period));
  const latestRatio = ratios[0] || {};
  const chronological = [...annual].sort((a, b) => a.period.localeCompare(b.period));
  const revenueTransitions = countPositiveTransitions(chronological.map((x) => x.revenue));
  const opPositiveYears = chronological.filter((x) => Number.isFinite(x.operatingIncome) && x.operatingIncome > 0).length;
  const opTransitions = countPositiveTransitions(chronological.map((x) => x.operatingIncome));

  let score = 0;
  score += revenueTransitions * 15; // 최대 30
  if (opPositiveYears === 3) score += 15;
  else if (opPositiveYears === 2) score += 8;
  if (opTransitions === 2) score += 5;
  const debt = latestRatio.debtRatio;
  if (Number.isFinite(debt)) {
    if (debt < 100) score += 20;
    else if (debt < 150) score += 15;
    else if (debt < 200) score += 5;
  }
  const reserve = latestRatio.reserveRatio;
  if (Number.isFinite(reserve)) {
    if (reserve >= 1000) score += 10;
    else if (reserve >= 500) score += 8;
    else if (reserve >= 200) score += 5;
    else if (reserve > 0) score += 2;
  }
  const roe = latestRatio.roe;
  if (Number.isFinite(roe)) {
    if (roe >= 15) score += 10;
    else if (roe >= 10) score += 8;
    else if (roe >= 5) score += 5;
    else if (roe > 0) score += 2;
  }
  const latestAnnual = annual[0] || {};
  const opMargin = Number.isFinite(latestAnnual.revenue) && Number.isFinite(latestAnnual.operatingIncome) && latestAnnual.revenue !== 0
    ? (latestAnnual.operatingIncome / latestAnnual.revenue) * 100
    : null;
  if (Number.isFinite(opMargin)) {
    if (opMargin >= 15) score += 10;
    else if (opMargin >= 10) score += 8;
    else if (opMargin >= 5) score += 5;
    else if (opMargin > 0) score += 2;
  }
  score = Math.min(100, score);

  let grade = "C";
  if (score >= 85) grade = "S";
  else if (score >= 70) grade = "A";
  else if (score >= 55) grade = "B";

  return {
    code,
    score,
    grade,
    revenueGrowing3y: chronological.length >= 3 && revenueTransitions === 2,
    revenueTransitions,
    operatingProfitPositive3y: chronological.length >= 3 && opPositiveYears === 3,
    annual,
    debtRatio: Number.isFinite(debt) ? debt : null,
    reserveRatio: Number.isFinite(reserve) ? reserve : null,
    roe: Number.isFinite(roe) ? roe : null,
    operatingMargin: Number.isFinite(opMargin) ? round(opMargin, 2) : null,
    errors: callResults.filter((x) => !x.ok).map((x) => `${x.label}: ${x.error}`),
    scoreRule: "3개년 매출 우상향 30 + 영업이익 안정성 20 + 부채비율 20 + 유보율 10 + ROE 10 + 영업이익률 10 (최대 100, 일부 지표 미제공 시 감점)",
  };
}

function countPositiveTransitions(values) {
  const clean = values.map((v) => Number(v));
  let count = 0;
  for (let i = 1; i < clean.length; i++) {
    if (Number.isFinite(clean[i - 1]) && Number.isFinite(clean[i]) && clean[i] > clean[i - 1]) count += 1;
  }
  return count;
}

async function kisDailyChart(env, code, targetRows = 190) {
  const collected = new Map();
  let end = new Date();

  for (let page = 0; page < 2 && collected.size < targetRows; page++) {
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
  const url = `${DART_BASE}/company.json?${qs}`;
  let res;
  try {
    res = await fetch(url, {
      redirect: "manual",
      headers: {
        accept: "application/json,text/plain,*/*",
        "user-agent": "FF-Value-Hunter/0.3 (Cloudflare Worker)",
      },
    });
  } catch (error) {
    throw new Error(`OpenDART 네트워크 오류: ${safeErrorMessage(error)}`);
  }

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get("location") || "";
    if (/error1\.html/i.test(location)) {
      throw new Error("OpenDART가 Cloudflare Worker 요청을 오류 페이지로 리디렉션했습니다. v0.4에서는 이 오류가 반복되지 않도록 리디렉션을 중단하고, 기업명·업종은 KIS로 대체합니다.");
    }
    throw new Error(`OpenDART가 예상치 못한 리디렉션을 반환했습니다 (HTTP ${res.status}).`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OpenDART가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status}).`);
  }
  if (!res.ok) throw new Error(`OpenDART HTTP ${res.status}: ${sanitizeText(data?.message || "요청 실패")}`);
  return data;
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

function buildFinance(annualRows, quarterRows, ratioRows, fiscalMonth = "12") {
  const fm = normalizeFiscalMonth(fiscalMonth) || "12";
  const annualAll = normalizeIncomeRows(annualRows).sort((a, b) => b.period.localeCompare(a.period));
  const annualFiltered = annualAll.filter((r) => r.period.endsWith(fm));
  const annual = (annualFiltered.length ? annualFiltered : annualAll).slice(0, 3);

  const quarterAllAsc = normalizeIncomeRows(quarterRows).sort((a, b) => a.period.localeCompare(b.period));
  const annualAsc = normalizeIncomeRows(annualRows).sort((a, b) => a.period.localeCompare(b.period));
  const cumulativeDetected = detectCumulativeQuarterRows(quarterAllAsc, annualAsc);
  const quarterRowsNormalized = cumulativeDetected
    ? toStandaloneQuarters(quarterAllAsc, annualAsc)
    : quarterAllAsc.map((r) => ({ ...r, label: quarterLabel(r.period), convertedFromCumulative: false }));
  const quarterly = quarterRowsNormalized
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 4);

  const ratioAll = (ratioRows || [])
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

  const annualRatios = ratioAll.filter((r) => r.period.endsWith(fm));

  return {
    annual,
    quarterly,
    ratios: (annualRatios.length ? annualRatios : ratioAll).slice(0, 3),
    latestRatio: ratioAll[0] || null,
    fiscalMonth: fm,
    amountUnit: "KIS 손익계산서 원자료 단위",
    note: cumulativeDetected
      ? "KIS 분기 조회값이 연간값과 일치하는 누적형으로 확인되어 Q2-Q1, Q3-Q2, 연간-Q3 방식으로 개별 분기를 환산했습니다."
      : "KIS 분기 조회값을 최근 4개 분기 원자료 기준으로 표시합니다. 누적형 여부가 검증되지 않은 종목은 임의 차감하지 않습니다.",
  };
}

function detectCumulativeQuarterRows(quarterRows, annualRows) {
  const annualMap = new Map((annualRows || []).filter((r) => r.period?.endsWith("12")).map((r) => [r.period, r]));
  for (const q of quarterRows || []) {
    if (!q.period?.endsWith("12")) continue;
    const a = annualMap.get(q.period);
    if (!a || !Number.isFinite(q.revenue) || !Number.isFinite(a.revenue) || a.revenue === 0) continue;
    const diff = Math.abs(q.revenue - a.revenue) / Math.abs(a.revenue);
    if (diff <= 0.02) return true;
  }
  return false;
}

function quarterLabel(period) {
  const s = String(period || "");
  if (!/^\d{6}$/.test(s)) return s || "-";
  const month = Number(s.slice(4, 6));
  const q = Math.max(1, Math.min(4, Math.ceil(month / 3)));
  return `${s.slice(0, 4)} Q${q}`;
}

function normalizeFiscalMonth(value) {
  const s = String(value || "").replace(/[^0-9]/g, "");
  if (/^\d{2}$/.test(s)) return s;
  if (/^\d{4}$/.test(s)) return s.slice(0, 2);
  if (/^\d{6}$/.test(s)) return s.slice(4, 6);
  return null;
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
    fiscalMonth: normalizeFiscalMonth(o.stac_month),
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

function buildIdentity(rawOutput, priceOutput, code) {
  const o = Array.isArray(rawOutput) ? (rawOutput[0] || {}) : (rawOutput || {});
  const p = priceOutput || {};
  const market = inferMarket(o);
  const sectorCandidates = [
    o.idx_bztp_scls_cd_name,
    o.idx_bztp_mcls_cd_name,
    o.idx_bztp_lcls_cd_name,
    p.bstp_kor_isnm,
  ].filter(Boolean);
  return {
    code,
    name: o.prdt_name || o.prdt_abrv_name || p.hts_kor_isnm || null,
    englishName: o.prdt_eng_name || o.prdt_eng_abrv_name || null,
    market,
    sector: sectorCandidates[0] || null,
    industryLarge: o.idx_bztp_lcls_cd_name || null,
    industryMedium: o.idx_bztp_mcls_cd_name || null,
    industrySmall: o.idx_bztp_scls_cd_name || null,
    industryStandard: o.std_idst_clsf_cd_name || null,
    fiscalMonth: normalizeFiscalMonth(o.setl_mmdd) || normalizeFiscalMonth(p.stac_month),
    settlementDate: o.setl_mmdd || null,
    listedDate: market === "KOSDAQ" ? (o.kosdaq_mket_lstg_dt || null) : (o.scts_mket_lstg_dt || null),
    kospi200: o.kospi200_item_yn || null,
    managementItem: o.admn_item_yn || null,
    tradingStopped: o.tr_stop_yn || null,
  };
}

function inferMarket(o = {}) {
  const id = String(o.mket_id_cd || "").toUpperCase();
  if (id.includes("KSQ") || id.includes("KQ") || (o.kosdaq_mket_lstg_dt && !o.kosdaq_mket_lstg_abol_dt)) return "KOSDAQ";
  if (id.includes("KNX") || id.includes("KONEX")) return "KONEX";
  if (id.includes("STK") || id.includes("KOSPI") || (o.scts_mket_lstg_dt && !o.scts_mket_lstg_abol_dt)) return "KOSPI";
  return id || null;
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

function sanitizeText(value) {
  let text = String(value ?? "");
  text = text.replace(/([?&](?:crtfc_key|appkey|appsecret|auth_key|key)=)[^&\s,]*/gi, "$1[REDACTED]");
  text = text.replace(/\b[a-f0-9]{40}\b/gi, "[REDACTED_KEY]");
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]");
  return text;
}

function safeErrorMessage(error) {
  return sanitizeText(error?.message || String(error || "알 수 없는 오류"));
}

function dartFriendlyError(error) {
  const msg = safeErrorMessage(error);
  if (/error1\.html|리디렉션|redirect/i.test(msg)) {
    return "OpenDART가 Cloudflare Worker 요청을 오류 페이지로 보내고 있습니다. 기업명·업종은 KIS로 정상 표시되며, DART 공시 기능만 보류됩니다. OpenDART 키의 허용환경/IP 상태도 확인해주세요.";
  }
  return msg;
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

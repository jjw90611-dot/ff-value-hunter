const KIS_BASE = "https://openapi.koreainvestment.com:9443";
const DART_BASE = "https://opendart.fss.or.kr/api";
const KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";
const ECOS_BASE = "https://ecos.bok.or.kr/api";
const APP_VERSION = "1.0.0";
const MASTER_BASE = "https://new.real.download.dws.co.kr/common/master";
const UNIVERSE_CACHE_URL = "https://ff-value-hunter-cache.local/stock-universe-v10";
const SECTOR_TREND_CACHE_PREFIX = "https://ff-value-hunter-cache.local/sector-trend-v10/";
const KRX_MARKET_CACHE_URL = "https://ff-value-hunter-cache.local/krx-market-v10";
const KRX_FAILURE_CACHE_URL = "https://ff-value-hunter-cache.local/krx-failure-v10";
const KIS_MIN_INTERVAL_MS = 450;
const KIS_TOKEN_CACHE_URL = "https://ff-value-hunter-token-cache.local/kis-access-token-v3";
const DART_CORP_CACHE_URL = "https://ff-value-hunter-cache.local/dart-corp-map-v10";

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
        try {
          const date = url.searchParams.get("date") || await findLatestKrxTradingDate(env);
          const checks = [
            ["유가증권 일별매매정보", () => krxKospiDaily(env, date)],
            ["코스닥 일별매매정보", () => krxKosdaqDaily(env, date)],
            ["유가증권 종목기본정보", () => krxKospiBaseInfo(env, date)],
            ["코스닥 종목기본정보", () => krxKosdaqBaseInfo(env, date)],
            ["KOSPI 시리즈 일별시세정보", () => krxKospiIndexDaily(env, date)],
            ["KOSDAQ 시리즈 일별시세정보", () => krxKosdaqIndexDaily(env, date)],
          ];
          const services = [];
          for (const [name, fn] of checks) {
            try {
              const data = await fn();
              services.push({ name, ok: true, rows: Array.isArray(data?.OutBlock_1) ? data.OutBlock_1.length : 0 });
            } catch (error) {
              services.push({ name, ok: false, error: safeErrorMessage(error) });
            }
          }
          const okCount = services.filter((x) => x.ok).length;
          return json({
            ok: true,
            available: okCount > 0,
            provider: "KRX",
            date,
            serviceOk: okCount,
            serviceTotal: services.length,
            services,
            message: okCount === services.length
              ? "승인받은 6개 KRX API가 모두 정상입니다."
              : `${okCount}/${services.length}개 KRX API가 정상입니다. 401이면 이용현황의 사용기간 시작일/승인상태를 확인하세요.`,
          });
        } catch (error) {
          const msg = safeErrorMessage(error);
          if (/401|Unauthorized API Call/i.test(msg)) {
            return json({
              ok: true,
              available: false,
              provider: "KRX",
              state: "approval-or-start-date",
              message: "KRX 인증키는 감지됐지만 API 호출이 401입니다. 이용현황의 개별 API 승인뿐 아니라 사용기간 시작일이 아직 도래하지 않은 경우에도 발생할 수 있습니다. 승인 시작일 이후 다시 점검하세요.",
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

        // v1.0 기반 유지:
        // KOSPI는 3=산업별구분을 우선 사용합니다. KOSDAQ의 3은 '일반구분'이라
        // 실제 산업 목록이 충분하지 않을 수 있어, 매핑 결과가 적으면 전업종(0)을
        // 다시 받아 '종목 마스터 대분류 코드가 실제로 존재하는 항목'만 남깁니다.
        const [kospiPrimary, kosdaqPrimary, universeRes] = await Promise.all([
          safeSource("KOSPI 산업", () => kisIndexCategory(env, "0001", "K", "3")),
          safeSource("KOSDAQ 일반/산업 후보", () => kisIndexCategory(env, "1001", "Q", "3")),
          safeSource("종목 마스터", () => loadStockUniverse()),
        ]);

        const universe = universeRes.value || [];
        const errors = [kospiPrimary, kosdaqPrimary, universeRes].filter((x) => !x.ok);

        const mapSectorRows = (data, marketName, marketCode) => {
          const raw = normalizeSectorList(data, marketName, marketCode)
            .filter((item) => item.name && item.code && isUsefulSector(item));
          const mapped = dedupeSectors(raw)
            .map((item) => {
              const resolved = resolveSectorMembers(universe, item.code, item.name, item.marketCode);
              return { ...item, memberCount: resolved.members.length, mappingMode: resolved.mode };
            })
            .filter((item) => item.memberCount > 0);
          return { raw, mapped };
        };

        let kospiSet = mapSectorRows(kospiPrimary.value, "KOSPI", "K");
        let kosdaqSet = mapSectorRows(kosdaqPrimary.value, "KOSDAQ", "Q");
        let fallbackUsed = false;

        // 산업 카드가 지나치게 적으면 해당 시장만 전업종 목록에서 재검증합니다.
        if (kospiSet.mapped.length < 5) {
          const fallback = await safeSource("KOSPI 전업종 폴백", () => kisIndexCategory(env, "0001", "K", "0"));
          if (!fallback.ok) errors.push(fallback);
          else { kospiSet = mapSectorRows(fallback.value, "KOSPI", "K"); fallbackUsed = true; }
        }
        if (kosdaqSet.mapped.length < 5) {
          const fallback = await safeSource("KOSDAQ 전업종 폴백", () => kisIndexCategory(env, "1001", "Q", "0"));
          if (!fallback.ok) errors.push(fallback);
          else { kosdaqSet = mapSectorRows(fallback.value, "KOSDAQ", "Q"); fallbackUsed = true; }
        }

        const sectors = dedupeSectors([...kospiSet.mapped, ...kosdaqSet.mapped])
          .sort((a, b) => (b.dayPct || 0) - (a.dayPct || 0));
        const rawCount = kospiSet.raw.length + kosdaqSet.raw.length;
        const dropped = Math.max(0, rawCount - sectors.length);

        if (!sectors.length) {
          const error = new Error("산업 목록은 수신했지만 종목 마스터와 매핑되는 섹터가 없습니다. KIS 업종/종목 마스터 데이터 형식을 다시 확인해주세요.");
          error.status = 502;
          throw error;
        }

        return json({
          ok: true,
          version: APP_VERSION,
          sectors,
          errors: errors.map((x) => ({ label: x.label, error: x.error })),
          diagnostics: {
            rawSectorCount: rawCount,
            investableSectorCount: sectors.length,
            droppedZeroMemberSectors: dropped,
            kospiSectorCount: kospiSet.mapped.length,
            kosdaqSectorCount: kosdaqSet.mapped.length,
            universeCount: universe.length,
            fallbackUsed,
          },
          note: "v1.0은 실제 상장기업이 1개 이상 정확히 매핑되는 산업 섹터만 화면에 노출합니다. 특수지수/파생지수/구성기업 0개 항목은 자동 제외합니다.",
        });
      }

      if (url.pathname === "/api/search-stocks") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const q = String(url.searchParams.get("q") || "").trim();
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 10), 1), 20);
        if (!q) return json({ ok: true, items: [] });
        let universe = await loadStockUniverse();

        // KRX 종목기본정보가 사용 가능하면 실제 영문 종목명을 검색에 결합합니다.
        if (hasBinding(env, "KRX_AUTH_KEY")) {
          const krxRes = await safeSource("KRX 종목기본정보", () => loadKrxMarketData(env));
          if (krxRes.ok && krxRes.value?.byCode) {
            const byCode = krxRes.value.byCode;
            universe = universe.map((item) => ({
              ...item,
              englishName: byCode[item.code]?.englishName || englishNameFor(item.code, item.name) || "",
              nameEn: byCode[item.code]?.englishName || englishNameFor(item.code, item.name) || "",
            }));
          }
        }
        const items = searchStocks(universe, q, limit);
        return json({ ok: true, query: q, items, version: APP_VERSION });
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
        const resolved = resolveSectorMembers(universe, code, name, market);

        let members = resolved.members.map(decorateMasterStock);
        let krx = { available: false, date: null };
        if (hasBinding(env, "KRX_AUTH_KEY")) {
          // KRX는 실제로 사용합니다. 다만 KRX 승인 시작 전/휴일/일시 오류가
          // 있어도 산업-기업 매핑 자체가 깨지지 않도록 보조 데이터로 결합합니다.
          const krxRes = await safeSource("KRX 시장데이터", () => loadKrxMarketData(env));
          if (krxRes.ok && krxRes.value?.byCode) {
            const byCode = krxRes.value.byCode;
            members = members.map((item) => ({ ...item, krx: byCode[item.code] || null }));
            krx = { available: true, date: krxRes.value.date || null };
          }
        }

        members.sort((a, b) => {
          const capA = Number(a.krx?.marketCapWon) || Number(a.marketCap) * 100000000 || 0;
          const capB = Number(b.krx?.marketCapWon) || Number(b.marketCap) * 100000000 || 0;
          return capB - capA;
        });

        return json({
          ok: true,
          sector: { code, name, market },
          total: members.length,
          mappingMode: resolved.mode,
          krx,
          members: members.slice(0, 300),
          note: resolved.mode === "industryLarge"
            ? "KIS 산업분류 코드와 종목 마스터 지수업종 대분류를 정확히 일치시켰습니다."
            : "KRX 명시 섹터명일 때만 해당 KRX 섹터 플래그를 사용했습니다. 일반 업종에는 테마 플래그를 섞지 않습니다.",
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
          // v1.0: 매출 절대규모보다 분기/연간 성장의 일관성 + Value를 중시합니다.
          const annualRes = await safeSource("연간 손익", () => kisIncomeStatement(env, code, "0"));
          const quarterRes = await safeSource("분기 손익", () => kisIncomeStatement(env, code, "1"));
          const ratioRes = await safeSource("재무비율", () => kisFinancialRatio(env, code, "0"));
          const priceRes = await safeSource("현재 밸류에이션", () => kisCurrentPrice(env, code));
          items.push(buildStockRankItem(
            code,
            annualRes.value?.output || [],
            quarterRes.value?.output || [],
            ratioRes.value?.output || [],
            priceRes.value?.output || {},
            [annualRes, quarterRes, ratioRes, priceRes]
          ));
        }
        return json({ ok: true, items, scoringVersion: "quarter-consistency-value-v10" });
      }


      if (url.pathname === "/api/deep-signals") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeCode(url.searchParams.get("code") || "005930");
        const name = String(url.searchParams.get("name") || "").trim();

        const investorRes = await safeSource("외국인·기관", () => kisInvestor(env, code));
        const dailyRes = await safeSource("외국인 보유비율", () => kisDailyPrice30(env, code));
        const chartRes = await safeSource("1년 가격·거래량", () => kisDailyChart(env, code, 270));

        const technical = analyzeTechnical(chartRes.value || []);
        const supply = analyzeSupply(investorRes.value?.output || [], dailyRes.value?.output || []);
        const accumulation = analyzeAccumulation(technical, supply);

        let disclosureRisk = { available: false, penalty: 0, items: [], corpCode: null, message: "DART 미사용" };
        if (hasBinding(env, "DART_API_KEY")) {
          try { disclosureRisk = await dartDisclosureRisk(env, code); }
          catch (error) { disclosureRisk = { available: false, penalty: 0, items: [], corpCode: null, message: safeErrorMessage(error) }; }
        }

        let newsRisk = { available: false, penalty: 0, headlines: [], message: "뉴스 보조신호 미사용" };
        if (name) {
          try { newsRisk = await fetchNewsRisk(name); }
          catch (error) { newsRisk = { available: false, penalty: 0, headlines: [], message: safeErrorMessage(error) }; }
        }

        const riskPenalty = Math.min(25, Number(disclosureRisk.penalty || 0) + Number(newsRisk.penalty || 0));
        return json({
          ok: true,
          code,
          accumulation,
          supply,
          technical: {
            price1yChangePct: technical.price1yChangePct ?? null,
            close: technical.close ?? null,
            ma20: technical.ma20 ?? null,
            ma60: technical.ma60 ?? null,
            ma120: technical.ma120 ?? null,
            zone: technical.zone || null,
          },
          risk: { penalty: riskPenalty, disclosure: disclosureRisk, news: newsRisk },
          sourceErrors: [investorRes, dailyRes, chartRes].filter((x) => !x.ok).map((x) => ({ label: x.label, error: x.error })),
        });
      }

      if (url.pathname === "/api/target-opinion") {
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        const code = normalizeCode(url.searchParams.get("code") || "005930");
        const end = new Date();
        const start = new Date(end);
        start.setUTCDate(start.getUTCDate() - 240);
        try {
          const raw = await kisInvestOpinion(env, code, yyyymmdd(start), yyyymmdd(end));
          const rows = Array.isArray(raw?.output) ? raw.output : raw?.output ? [raw.output] : [];
          const normalized = rows
            .map((r) => ({
              date: String(r.stck_bsop_date || ""),
              opinion: String(r.invt_opnn || "").trim() || null,
              targetPrice: numOrNull(r.hts_goal_prc),
              priorClose: numOrNull(r.stck_prdy_clpr),
            }))
            .filter((r) => Number.isFinite(r.targetPrice) && r.targetPrice > 0)
            .sort((a, b) => b.date.localeCompare(a.date));
          return json({ ok: true, code, latest: normalized[0] || null, rows: normalized.slice(0, 12) });
        } catch (error) {
          return json({ ok: true, code, latest: null, rows: [], warning: safeErrorMessage(error) });
        }
      }

      if (url.pathname === "/api/loopera-advice") {
        if (request.method !== "POST") return json({ ok: false, error: "POST 요청만 지원합니다." }, 405);
        requireEnv(env, ["KIS_APP_KEY", "KIS_APP_SECRET"]);
        let body;
        try { body = await request.json(); }
        catch { return json({ ok: false, error: "요청 JSON을 읽지 못했습니다." }, 400); }

        const candidate = body?.candidate && typeof body.candidate === "object" ? body.candidate : {};
        const member = body?.member && typeof body.member === "object" ? body.member : {};
        const sector = body?.sector && typeof body.sector === "object" ? body.sector : {};
        const peerContext = body?.peerContext && typeof body.peerContext === "object" ? body.peerContext : {};
        const code = normalizeCode(candidate.code || member.code || "");

        let accounting = { available: false, message: "DART 재무제표 원문 검증 미사용" };
        let accountingError = null;
        if (hasBinding(env, "DART_API_KEY")) {
          try { accounting = await dartResearchSnapshot(env, code); }
          catch (error) { accountingError = safeErrorMessage(error); accounting = { available: false, message: accountingError }; }
        }

        const advice = buildLooperaAdvice({ code, candidate, member, sector, peerContext, accounting });
        return json({
          ok: true,
          version: APP_VERSION,
          code,
          generatedAt: new Date().toISOString(),
          methodology: {
            name: "Loopera's Advice · independent evidence-gated implementation",
            independentImplementation: true,
            sourceCodeCopied: false,
            principles: ["Hypothesis-driven", "Evidence-gated", "Research Memory", "competing mechanisms", "invalidation conditions"],
            limitation: "현재 단계는 실시간 후보의 결정론적 Evidence Gate입니다. 실제 Rank IC·Sharpe·MDD·Neutralized IC·Incremental Residual IC·독립 OOS 성능은 과거 시점별 패널과 walk-forward 백테스트를 구축하기 전에는 계산하거나 표시하지 않습니다.",
          },
          accounting,
          accountingError,
          advice,
        });
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

async function kisInvestOpinion(env, code, startDate, endDate) {
  return kisGet(env, "/uapi/domestic-stock/v1/quotations/invest-opinion", "FHKST663300C0", {
    FID_COND_MRKT_DIV_CODE: "J",
    FID_COND_SCR_DIV_CODE: "16633",
    FID_INPUT_ISCD: code,
    FID_INPUT_DATE_1: startDate,
    FID_INPUT_DATE_2: endDate,
  });
}


async function kisIndexCategory(env, inputCode, marketCls, belongingCode = "3") {
  return kisGet(env, "/uapi/domestic-stock/v1/quotations/inquire-index-category-price", "FHPUP02140000", {
    FID_COND_MRKT_DIV_CODE: "U",
    FID_INPUT_ISCD: inputCode,
    FID_COND_SCR_DIV_CODE: "20214",
    FID_MRKT_CLS_CODE: marketCls,
    FID_BLNG_CLS_CODE: belongingCode,
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

  // 이 화면의 목적은 '산업 → 기업' 발굴입니다. 구성기업이 없는 지수/파생/채권/
  // 스마트베타/테마성 지수는 STEP 1에서 제거합니다. 최종적으로는 /api/sectors에서
  // 실제 종목 마스터 매칭이 1개 이상인지 한 번 더 검증합니다.
  if (/^(종합|대형주|중형주|소형주|우선주|코스피|코스닥|KOSPI|KOSDAQ|코스피200|코스닥150)$/i.test(name)) return false;
  if (/(선물|채권|TMI|스마트베타|기후변화|혼합|레버리지|인버스|F-K|F_K|ETF|ETN)/i.test(name)) return false;
  if (/^(KOSPI|KOSDAQ)\d+/i.test(name)) return false;
  if (/^KRX/i.test(name) && !strictKrxSectorFlag(name)) return false;
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

  if (clean.length < 40) {
    return { ok: false, rows: clean.length, score: 0, grade: "N/A", label: "데이터 부족", series: clean };
  }

  const closes = clean.map((r) => r.close);
  const last = closes.at(-1);
  const ma20 = closes.length >= 20 ? sma(closes, 20) : null;
  const ma60 = closes.length >= 60 ? sma(closes, 60) : null;
  const ma120 = closes.length >= 120 ? sma(closes, 120) : null;

  const ma20Ago10 = closes.length >= 30 ? sma(closes.slice(0, -10), 20) : null;
  const ma60Ago20 = closes.length >= 80 ? sma(closes.slice(0, -20), 60) : null;
  const ma120Ago20 = closes.length >= 140 ? sma(closes.slice(0, -20), 120) : null;

  const ret20 = closes.length > 20 ? pct(last, closes.at(-21)) : null;
  const ret60 = closes.length > 60 ? pct(last, closes.at(-61)) : null;
  const ret120 = closes.length > 120 ? pct(last, closes.at(-121)) : null;

  const gapLastMa20 = Number.isFinite(ma20) ? pct(last, ma20) : null;
  const gapMa20Ma60 = Number.isFinite(ma20) && Number.isFinite(ma60) ? pct(ma20, ma60) : null;
  const gapMa60Ma120 = Number.isFinite(ma60) && Number.isFinite(ma120) ? pct(ma60, ma120) : null;

  const slope20 = Number.isFinite(ma20Ago10) ? pct(ma20, ma20Ago10) : null;
  const slope60 = Number.isFinite(ma60Ago20) ? pct(ma60, ma60Ago20) : null;
  const slope120 = Number.isFinite(ma120Ago20) ? pct(ma120, ma120Ago20) : null;

  const positive20 = positiveDayRatio(closes.slice(-21));
  const positive60 = positiveDayRatio(closes.slice(-61));
  const drawdown60 = maxDrawdownPct(closes.slice(-61));
  const range120 = rangePositionPct(closes.slice(-121));

  // v1.0: 모든 항목을 0/5/10 식의 계단 점수로 주지 않고 실제 퍼센트 값을 연속 점수로 변환합니다.
  // 같은 정배열이라도 이격도, 기울기, 20·60·120일 수익률, 상승일 비율, 낙폭이 다르면 점수도 달라집니다.
  const structureScore =
    smoothBandScore(gapLastMa20, -4, 5, 8) +
    smoothBandScore(gapMa20Ma60, -5, 9, 9) +
    smoothBandScore(gapMa60Ma120, -8, 16, 8);

  const slopeScore =
    smoothBandScore(slope20, -3, 6, 8) +
    smoothBandScore(slope60, -3, 8, 9) +
    smoothBandScore(slope120, -2, 7, 8);

  const momentumScore =
    smoothBandScore(ret20, -10, 18, 8) +
    smoothBandScore(ret60, -15, 35, 12) +
    smoothBandScore(ret120, -25, 65, 10);

  const persistenceScore =
    clamp01(((positive20 ?? 0.5) - 0.35) / 0.35) * 5 +
    clamp01(((positive60 ?? 0.5) - 0.38) / 0.30) * 5;

  // 큰 낙폭은 감점하고, 120일 범위 상단에 안정적으로 위치하면 소폭 가점합니다.
  const ddQuality = Number.isFinite(drawdown60) ? clamp01((drawdown60 + 28) / 23) * 6 : 3;
  const rangeQuality = Number.isFinite(range120) ? clamp01((range120 - 35) / 55) * 4 : 2;
  const qualityScore = ddQuality + rangeQuality;

  const score = round(Math.max(0, Math.min(100,
    structureScore + slopeScore + momentumScore + persistenceScore + qualityScore
  )), 1);

  const fullAligned = Number.isFinite(ma120)
    ? last > ma20 && ma20 > ma60 && ma60 > ma120
    : Number.isFinite(ma60) && last > ma20 && ma20 > ma60;
  const rising = (slope20 ?? 0) > 0 && (slope60 ?? 0) > 0 && (ma120 === null || (slope120 ?? 0) > 0);

  let grade = "D";
  let label = "혼조/약세";
  if (score >= 90 && fullAligned && rising) { grade = "S"; label = "최상위 정배열 상승"; }
  else if (score >= 82) { grade = "A+"; label = "강한 상승추세"; }
  else if (score >= 74) { grade = "A"; label = "상승 우위"; }
  else if (score >= 66) { grade = "B"; label = "완만한 상승"; }
  else if (score >= 58) { grade = "C"; label = "상승 전환/관찰"; }

  return {
    ok: true,
    rows: clean.length,
    date: clean.at(-1)?.date || null,
    score,
    grade,
    label,
    close: round(last, 2),
    ma20: Number.isFinite(ma20) ? round(ma20, 2) : null,
    ma60: Number.isFinite(ma60) ? round(ma60, 2) : null,
    ma120: Number.isFinite(ma120) ? round(ma120, 2) : null,
    gapLastMa20Pct: Number.isFinite(gapLastMa20) ? round(gapLastMa20, 2) : null,
    gapMa20Ma60Pct: Number.isFinite(gapMa20Ma60) ? round(gapMa20Ma60, 2) : null,
    gapMa60Ma120Pct: Number.isFinite(gapMa60Ma120) ? round(gapMa60Ma120, 2) : null,
    ma20Slope10dPct: Number.isFinite(slope20) ? round(slope20, 2) : null,
    ma60Slope20dPct: Number.isFinite(slope60) ? round(slope60, 2) : null,
    ma120Slope20dPct: Number.isFinite(slope120) ? round(slope120, 2) : null,
    return20d: Number.isFinite(ret20) ? round(ret20, 2) : null,
    return60d: Number.isFinite(ret60) ? round(ret60, 2) : null,
    return120d: Number.isFinite(ret120) ? round(ret120, 2) : null,
    positiveDays20Pct: Number.isFinite(positive20) ? round(positive20 * 100, 1) : null,
    positiveDays60Pct: Number.isFinite(positive60) ? round(positive60 * 100, 1) : null,
    maxDrawdown60Pct: Number.isFinite(drawdown60) ? round(drawdown60, 2) : null,
    rangePosition120Pct: Number.isFinite(range120) ? round(range120, 1) : null,
    scoreBreakdown: {
      structure: round(structureScore, 1),
      slope: round(slopeScore, 1),
      momentum: round(momentumScore, 1),
      persistence: round(persistenceScore, 1),
      riskQuality: round(qualityScore, 1),
    },
    aligned: fullAligned,
    rising,
    wavePass: fullAligned && rising,
    series: clean.slice(-160).map((r, idx, arr) => {
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
    rule: "정배열 이격도 25 + 이동평균 기울기 25 + 20·60·120일 모멘텀 30 + 상승 지속성 10 + 낙폭/범위 위치 10을 실제 퍼센트 기반 연속점수로 계산",
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function smoothBandScore(value, low, high, weight) {
  if (!Number.isFinite(value)) return weight * 0.42;
  return clamp01((value - low) / (high - low)) * weight;
}

function positiveDayRatio(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (nums.length < 2) return null;
  let positive = 0;
  let total = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] > nums[i - 1]) positive += 1;
    total += 1;
  }
  return total ? positive / total : null;
}

function maxDrawdownPct(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  let peak = nums[0];
  let worst = 0;
  for (const value of nums) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, ((value - peak) / peak) * 100);
  }
  return worst;
}

function rangePositionPct(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  const low = Math.min(...nums);
  const high = Math.max(...nums);
  const last = nums.at(-1);
  if (high === low) return 50;
  return ((last - low) / (high - low)) * 100;
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

function searchStocks(universe, query, limit = 10) {
  const q = String(query || "").trim();
  const qNorm = normalizeSearchText(q);
  if (!qNorm) return [];

  const rows = [];
  for (const item of universe || []) {
    if (!isInvestmentCandidate(item)) continue;
    const nameNorm = normalizeSearchText(item.name);
    const alias = String(item.englishName || item.nameEn || englishNameFor(item.code, item.name) || "");
    const aliasNorm = normalizeSearchText(alias);
    const marketNorm = normalizeSearchText(item.market);
    const code = String(item.code || "");
    let score = 0;

    if (code === qNorm) score = 1000;
    else if (code.startsWith(qNorm)) score = 920;
    else if (nameNorm === qNorm) score = 880;
    else if (nameNorm.startsWith(qNorm)) score = 810;
    else if (aliasNorm === qNorm) score = 780;
    else if (aliasNorm.startsWith(qNorm)) score = 740;
    else if (nameNorm.includes(qNorm)) score = 700;
    else if (aliasNorm.includes(qNorm)) score = 640;
    else if (`${nameNorm}${marketNorm}`.includes(qNorm)) score = 560;

    if (!score) continue;
    score += Math.min(Number(item.marketCap) || 0, 999999999) / 100000000;
    rows.push({
      score,
      item: {
        code: item.code,
        name: item.name,
        market: item.market,
        englishName: alias || "",
        nameEn: alias || "",
        searchHint: [item.industryLarge, item.industryMedium].filter(Boolean).join(" · ") || item.market,
        marketCap: item.marketCap,
      },
    });
  }

  rows.sort((a, b) => b.score - a.score || (Number(b.item.marketCap) || 0) - (Number(a.item.marketCap) || 0) || String(a.item.name).localeCompare(String(b.item.name), "ko"));
  const unique = new Map();
  for (const row of rows) {
    if (!unique.has(row.item.code)) unique.set(row.item.code, row.item);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

function normalizeSearchText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9가-힣]+/g, "");
}

const ENGLISH_NAME_BY_CODE = Object.freeze({
  "005930": "Samsung Electronics",
  "00.7.0": "SK hynix",
  "035420": "NAVER",
  "035720": "Kakao",
  "005380": "Hyundai Motor Company",
  "000270": "Kia",
  "012330": "Hyundai Mobis",
  "051910": "LG Chem",
  "373220": "LG Energy Solution",
  "0.7.00": "Samsung SDI",
  "066570": "LG Electronics",
  "009150": "Samsung Electro-Mechanics",
  "207940": "Samsung Biologics",
  "068270": "Celltrion",
  "005490": "POSCO Holdings",
  "00.7.0": "POSCO Future M",
  "028260": "Samsung C&T",
  "034730": "SK Inc.",
  "096770": "SK Innovation",
  "017670": "SK Telecom",
  "030200": "KT",
  "105560": "KB Financial Group",
  "055550": "Shinhan Financial Group",
  "086790": "Hana Financial Group",
  "316140": "Woori Financial Group",
  "012450": "Hanwha Aerospace",
  "272210": "Hanwha Systems",
  "042660": "Hanwha Ocean",
  "064350": "Hyundai Rotem",
  "047810": "Korea Aerospace Industries",
  "034020": "Doosan Enerbility",
  "454910": "Doosan Robotics",
  "009540": "HD Korea Shipbuilding & Offshore Engineering",
  "329180": "HD Hyundai Heavy Industries",
  "010620": "HD Hyundai Mipo",
  "010140": "Samsung Heavy Industries",
  "267260": "HD Hyundai Electric",
  "298040": "Hyosung Heavy Industries",
  "010120": "LS ELECTRIC",
  "042700": "Hanmi Semiconductor",
  "240810": "Wonik IPS",
  "036930": "Jusung Engineering",
  "00.7.0": "ISU Petasys",
  "247540": "EcoPro BM",
  "086520": "EcoPro",
  "196170": "ALTEOGEN",
  "352820": "HYBE",
  "041510": "SM Entertainment",
  "035900": "JYP Entertainment",
  "122870": "YG Entertainment",
  "259960": "KRAFTON",
  "293490": "Kakao Games",
  "263750": "Pearl Abyss"
});

function englishNameFor(code, name) {
  return ENGLISH_NAME_BY_CODE[String(code || "")] || companyAliasText(name) || "";
}

function decorateMasterStock(item = {}) {
  const englishName = englishNameFor(item.code, item.name);
  return { ...item, englishName, nameEn: englishName };
}

function companyAliasText(name) {
  let out = ` ${String(name || "").toLowerCase()} `;
  const map = [
    [/삼성/g, " samsung "],
    [/현대/g, " hyundai "],
    [/기아/g, " kia "],
    [/엘지|lg/g, " lg "],
    [/에스케이|SK|sk/g, " sk "],
    [/포스코/g, " posco "],
    [/롯데/g, " lotte "],
    [/한화/g, " hanwha "],
    [/두산/g, " doosan "],
    [/효성/g, " hyosung "],
    [/카카오/g, " kakao "],
    [/네이버/g, " naver "],
    [/셀트리온/g, " celltrion "],
    [/신한/g, " shinhan "],
    [/하나/g, " hana "],
    [/우리/g, " woori "],
    [/국민|kb/g, " kb "],
    [/전자/g, " electronics "],
    [/전기/g, " electric "],
    [/전지/g, " battery "],
    [/반도체/g, " semiconductor "],
    [/화학/g, " chemical "],
    [/금융/g, " financial "],
    [/은행/g, " bank "],
    [/증권/g, " securities "],
    [/생명/g, " life "],
    [/보험/g, " insurance "],
    [/중공업/g, " heavy industries "],
    [/중공/g, " heavy industry "],
    [/물산/g, " c&t trading "],
    [/건설/g, " construction "],
    [/에너지/g, " energy "],
    [/조선/g, " shipbuilding "],
    [/자동차/g, " motor "],
    [/제약/g, " pharma "],
    [/바이오/g, " bio "],
    [/통신/g, " telecom "],
    [/항공/g, " air "],
    [/홀딩스|지주/g, " holdings "],
  ];
  for (const [rx, repl] of map) out = out.replace(rx, repl);
  out = out.replace(/\s+/g, " ").trim();
  return out && out !== String(name || "").toLowerCase().trim() ? titleCaseAlias(out) : "";
}

function titleCaseAlias(text) {
  return String(text || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => /^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function resolveSectorMembers(universe, sectorCode, sectorName, marketCode) {
  const target = normalizeIndustryCode(sectorCode);
  const exact = [];

  for (const item of universe || []) {
    if (marketCode === "K" && item.market !== "KOSPI") continue;
    if (marketCode === "Q" && item.market !== "KOSDAQ") continue;
    if (!isInvestmentCandidate(item)) continue;
    if (normalizeIndustryCode(item.industryLarge) === target) {
      exact.push({ ...item, sectorMatch: "industryLarge" });
    }
  }

  if (exact.length) return { mode: "industryLarge", members: dedupeStocks(exact) };

  // 'KRX 보험', 'KRX 건설'처럼 이름 자체가 KRX 섹터임이 명확한 경우에만
  // 공식 종목 마스터의 KRX 섹터 플래그를 사용합니다.
  // 일반 '건설', '보험'에는 이 폴백을 절대 적용하지 않아 잘못된 관련주 혼입을 막습니다.
  const flag = strictKrxSectorFlag(sectorName);
  if (!flag) return { mode: "unmapped", members: [] };

  const flagged = [];
  for (const item of universe || []) {
    if (marketCode === "K" && item.market !== "KOSPI") continue;
    if (marketCode === "Q" && item.market !== "KOSDAQ") continue;
    if (!isInvestmentCandidate(item)) continue;
    if (isYesFlag(item.flags?.[flag])) flagged.push({ ...item, sectorMatch: `krxFlag:${flag}` });
  }
  return { mode: `krxFlag:${flag}`, members: dedupeStocks(flagged) };
}

function selectSectorMembers(universe, sectorCode, sectorName, marketCode) {
  return resolveSectorMembers(universe, sectorCode, sectorName, marketCode).members;
}

function dedupeStocks(items) {
  const uniq = new Map();
  for (const item of items || []) {
    if (item?.code) uniq.set(item.code, item);
  }
  return [...uniq.values()];
}

function strictKrxSectorFlag(name) {
  const n = String(name || "").replace(/[\s·_\-]/g, "").toUpperCase();
  const map = [
    [/^KRX자동차$/, "auto"],
    [/^KRX반도체$/, "semiconductor"],
    [/^KRX바이오$/, "bio"],
    [/^KRX은행$/, "bank"],
    [/^KRX에너지화학$/, "energyChem"],
    [/^KRX철강$/, "steel"],
    [/^KRX미디어통신$/, "mediaComm"],
    [/^KRX건설$/, "construction"],
    [/^KRX증권$/, "securities"],
    [/^KRX선박$/, "ship"],
    [/^KRX보험$/, "insurance"],
    [/^KRX운송$/, "transport"],
  ];
  for (const [rx, key] of map) if (rx.test(n)) return key;
  return null;
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

function buildStockRankItem(code, annualRows, quarterRows, ratioRows, priceOutput = {}, callResults = []) {
  const annual = normalizeIncomeRows(annualRows)
    .filter((r) => r.period)
    .sort((a, b) => b.period.localeCompare(a.period))
    .slice(0, 4);
  const ratios = (ratioRows || []).map((r) => ({
    period: normalizePeriod(r.stac_yymm),
    reserveRatio: numOrNull(r.rsrv_rate),
    debtRatio: numOrNull(r.lblt_rate),
    roe: numOrNull(r.roe_val),
  })).filter((r) => r.period).sort((a, b) => b.period.localeCompare(a.period));

  const latestRatio = ratios[0] || {};
  const chronological = [...annual].sort((a, b) => a.period.localeCompare(b.period));
  const revenues = chronological.map((x) => x.revenue);
  const operating = chronological.map((x) => x.operatingIncome);
  const revenueTransitions = countPositiveTransitions(revenues);
  const opPositiveYears = chronological.filter((x) => Number.isFinite(x.operatingIncome) && x.operatingIncome > 0).length;
  const opTransitions = countPositiveTransitions(operating);
  const revenueCagr = cagrPercent(revenues);
  const opCagr = cagrPercent(operating);

  const latestAnnual = annual[0] || {};
  const opMargin = marginPct(latestAnnual.operatingIncome, latestAnnual.revenue);
  const debt = latestRatio.debtRatio;
  const reserve = latestRatio.reserveRatio;
  const roe = latestRatio.roe;

  // 분기 원자료가 누적형이면 개별 분기로 환산한 뒤 최대 12개 분기를 사용합니다.
  const quarterHistory = normalizeStandaloneQuartersForScoring(quarterRows, annualRows).slice(-12);
  const quarterMetrics = analyzeQuarterConsistency(quarterHistory);

  // Quality 100: 분기 실적 일관성을 가장 크게 반영합니다.
  // 분기 50 + 연간 15 + 재무안정성 15 + 수익성/자본효율 10 + 흑자지속 10
  const quarterlyScore = quarterMetrics.score;

  let annualScore = 0;
  if (chronological.length >= 2) {
    annualScore += clamp01(revenueTransitions / Math.max(1, chronological.length - 1)) * 6;
    annualScore += smoothBandScore(revenueCagr, -6, 18, 5);
    annualScore += clamp01(opTransitions / Math.max(1, chronological.length - 1)) * 2;
    annualScore += smoothBandScore(opCagr, -10, 28, 2);
  } else annualScore = 5;

  const debtScore = Number.isFinite(debt)
    ? Math.max(0, Math.min(10, 10 * (1 - Math.max(0, debt - 30) / 220)))
    : 3.5;
  const reserveScore = Number.isFinite(reserve)
    ? Math.max(0, Math.min(5, (Math.log10(Math.max(0, reserve) + 1) / Math.log10(3001)) * 5))
    : 1.5;
  const stabilityScore = debtScore + reserveScore;

  const roeScore = Number.isFinite(roe) ? smoothBandScore(roe, -1, 22, 6) : 2;
  const marginScore = Number.isFinite(opMargin) ? smoothBandScore(opMargin, -1, 20, 4) : 1.5;
  const profitabilityScore = roeScore + marginScore;

  let profitPersistenceScore = 0;
  if (chronological.length) profitPersistenceScore += clamp01(opPositiveYears / chronological.length) * 5;
  if (quarterHistory.length) {
    const qPositive = quarterHistory.filter((x) => Number(x.operatingIncome) > 0).length;
    profitPersistenceScore += clamp01(qPositive / quarterHistory.length) * 5;
  } else profitPersistenceScore += 2;

  const qualityBeforePenalty = quarterlyScore + annualScore + stabilityScore + profitabilityScore + profitPersistenceScore;
  const spikePenalty = quarterMetrics.oneOffSpikePenalty;
  const qualityScore = round(Math.max(0, Math.min(100, qualityBeforePenalty - spikePenalty)), 1);

  const p = priceOutput || {};
  const price = numOrNull(p.stck_prpr);
  const per = numOrNull(p.per);
  const pbr = numOrNull(p.pbr);
  const eps = numOrNull(p.eps);
  const bps = numOrNull(p.bps);
  const high52 = firstFinite(numOrNull(p.d250_hgpr), numOrNull(p.w52_hgpr), numOrNull(p.stck_dryy_hgpr));
  const low52 = firstFinite(numOrNull(p.d250_lwpr), numOrNull(p.w52_lwpr), numOrNull(p.stck_dryy_lwpr));
  const position52 = Number.isFinite(price) && Number.isFinite(high52) && Number.isFinite(low52) && high52 > low52
    ? Math.max(0, Math.min(100, ((price - low52) / (high52 - low52)) * 100))
    : null;
  const earningsYield = Number.isFinite(per) && per > 0 ? 100 / per : null;
  const pbrToRoe = Number.isFinite(pbr) && Number.isFinite(roe) && roe > 0 ? pbr / roe : null;
  const grahamFair = Number.isFinite(eps) && eps > 0 && Number.isFinite(bps) && bps > 0
    ? Math.sqrt(22.5 * eps * bps)
    : null;

  const trapWarnings = [];
  if (Number.isFinite(roe) && roe <= 0) trapWarnings.push("ROE 0% 이하");
  if (Number.isFinite(debt) && debt >= 200) trapWarnings.push("부채비율 200% 이상");
  if (chronological.length >= 3 && revenueTransitions === 0) trapWarnings.push("최근 연간 매출 감소");
  if (chronological.length >= 3 && opPositiveYears < 2) trapWarnings.push("연간 영업이익 흑자 지속성 부족");
  if (quarterMetrics.testPass === false) trapWarnings.push("최근 4분기 성장 검증 미통과");
  if (quarterMetrics.oneOffSpikePenalty >= 5) trapWarnings.push("한 분기 일회성 급증 가능성");

  return {
    code,
    score: qualityScore,
    grade: gradeFromScore(qualityScore),
    qualityScore,
    qualityGrade: gradeFromScore(qualityScore),
    valueScore: null,
    finalScore: null,
    revenueGrowing3y: chronological.length >= 3 && revenueTransitions >= chronological.length - 1,
    revenueTransitions,
    revenueCagr: Number.isFinite(revenueCagr) ? round(revenueCagr, 2) : null,
    operatingProfitPositive3y: chronological.length >= 3 && opPositiveYears >= 3,
    operatingCagr: Number.isFinite(opCagr) ? round(opCagr, 2) : null,
    annual: annual.slice(0, 3),
    quarterly: quarterHistory.slice(-8).reverse(),
    quarterlyMetrics: quarterMetrics,
    debtRatio: Number.isFinite(debt) ? debt : null,
    reserveRatio: Number.isFinite(reserve) ? reserve : null,
    roe: Number.isFinite(roe) ? roe : null,
    operatingMargin: Number.isFinite(opMargin) ? round(opMargin, 2) : null,
    valuation: {
      price, per, pbr, eps, bps, high52, low52,
      high52Date: String(p.d250_hgpr_date || p.w52_hgpr_date || p.dryy_hgpr_date || "") || null,
      low52Date: String(p.d250_lwpr_date || p.w52_lwpr_date || p.dryy_lwpr_date || "") || null,
      position52: Number.isFinite(position52) ? round(position52, 2) : null,
      earningsYield: Number.isFinite(earningsYield) ? round(earningsYield, 2) : null,
      pbrToRoe: Number.isFinite(pbrToRoe) ? round(pbrToRoe, 4) : null,
      grahamFair: Number.isFinite(grahamFair) ? round(grahamFair, 0) : null,
    },
    valueTrapWarnings: trapWarnings,
    scoreBreakdown: {
      quarterly: round(quarterlyScore, 1),
      annual: round(annualScore, 1),
      stability: round(stabilityScore, 1),
      profitability: round(profitabilityScore, 1),
      profitPersistence: round(profitPersistenceScore, 1),
      spikePenalty: round(spikePenalty, 1),
    },
    errors: callResults.filter((x) => !x.ok).map((x) => `${x.label}: ${x.error}`),
    scoreRule: "Quality 100 = 분기 성장·일관성 50 + 연간 15 + 재무안정성 15 + ROE·영업이익률 10 + 흑자지속 10 - 일회성 분기 급증 페널티",
  };
}

function normalizeStandaloneQuartersForScoring(quarterRows, annualRows) {
  const qAsc = normalizeIncomeRows(quarterRows).sort((a, b) => a.period.localeCompare(b.period));
  const aAsc = normalizeIncomeRows(annualRows).sort((a, b) => a.period.localeCompare(b.period));
  const cumulative = detectCumulativeQuarterRows(qAsc, aAsc);
  const rows = cumulative
    ? toStandaloneQuarters(qAsc, aAsc)
    : qAsc.map((r) => ({ ...r, label: quarterLabel(r.period), convertedFromCumulative: false }));
  const uniq = new Map();
  for (const row of rows) if (row.period && Number.isFinite(row.revenue)) uniq.set(row.period, row);
  return [...uniq.values()].sort((a, b) => a.period.localeCompare(b.period));
}

function analyzeQuarterConsistency(rows) {
  const q = (rows || []).filter((x) => Number.isFinite(x.revenue) && x.revenue > 0).slice(-12);
  if (q.length < 4) {
    return { score: 18, trainPass: null, testPass: null, oneOffSpikePenalty: 0, message: "분기 데이터 부족" };
  }
  const test = q.slice(-4);
  const train = q.slice(0, Math.max(0, q.length - 4));
  const testRev = test.map((x) => Number(x.revenue));
  const testMargin = test.map((x) => marginPct(x.operatingIncome, x.revenue)).filter(Number.isFinite);
  const trainRev = train.map((x) => Number(x.revenue));
  const trainMargin = train.map((x) => marginPct(x.operatingIncome, x.revenue)).filter(Number.isFinite);

  const testRevenueTransitionRatio = positiveTransitionRatio(testRev);
  const testMarginTransitionRatio = positiveTransitionRatio(testMargin);
  const testRevenueSlope = linearSlopePct(testRev);
  const testMarginSlope = linearSlopePct(testMargin);
  const trainRevenueSlope = trainRev.length >= 4 ? linearSlopePct(trainRev) : null;
  const trainMarginSlope = trainMargin.length >= 4 ? linearSlopePct(trainMargin) : null;

  let yoyRevenuePositive = null;
  let yoyOperatingPositive = null;
  let ttmRevenueGrowth = null;
  let ttmOperatingGrowth = null;
  if (q.length >= 8) {
    const recent4 = q.slice(-4);
    const prev4 = q.slice(-8, -4);
    const revYoy = recent4.map((x, i) => pctChange(x.revenue, prev4[i]?.revenue));
    const opYoy = recent4.map((x, i) => pctChange(x.operatingIncome, prev4[i]?.operatingIncome));
    yoyRevenuePositive = revYoy.filter((x) => Number.isFinite(x) && x > 0).length / 4;
    yoyOperatingPositive = opYoy.filter((x) => Number.isFinite(x) && x > 0).length / 4;
    ttmRevenueGrowth = pctChange(sumValues(recent4, "revenue"), sumValues(prev4, "revenue"));
    ttmOperatingGrowth = pctChange(sumValues(recent4, "operatingIncome"), sumValues(prev4, "operatingIncome"));
  }

  const trainPass = trainRev.length >= 4 ? (Number(trainRevenueSlope) > 0 && (trainMargin.length < 4 || Number(trainMarginSlope) >= -0.15)) : null;
  const testPass = Number(testRevenueSlope) > 0 && Number(testMarginSlope) >= 0 && testRevenueTransitionRatio >= 2/3;

  let score = 0;
  score += testRevenueTransitionRatio * 10;
  score += smoothBandScore(testRevenueSlope, -3, 8, 8);
  score += testMarginTransitionRatio * 8;
  score += smoothBandScore(testMarginSlope, -0.5, 1.5, 7);
  score += (yoyRevenuePositive == null ? 0.45 : yoyRevenuePositive) * 6;
  score += (yoyOperatingPositive == null ? 0.4 : yoyOperatingPositive) * 5;
  if (trainPass === true && testPass === true) score += 6;
  else if (testPass === true) score += 3;

  const oneOffSpikePenalty = detectOneOffSpikePenalty(q);
  score = Math.max(0, Math.min(50, score));
  return {
    score: round(score, 1),
    trainPass,
    testPass,
    trainCount: train.length,
    testCount: test.length,
    testRevenueSlopePctPerQuarter: Number.isFinite(testRevenueSlope) ? round(testRevenueSlope, 2) : null,
    testMarginSlopePpPerQuarter: Number.isFinite(testMarginSlope) ? round(testMarginSlope, 2) : null,
    testRevenueTransitionRatio: round(testRevenueTransitionRatio * 100, 1),
    testMarginTransitionRatio: round(testMarginTransitionRatio * 100, 1),
    yoyRevenuePositiveRatio: yoyRevenuePositive == null ? null : round(yoyRevenuePositive * 100, 1),
    yoyOperatingPositiveRatio: yoyOperatingPositive == null ? null : round(yoyOperatingPositive * 100, 1),
    ttmRevenueGrowth: Number.isFinite(ttmRevenueGrowth) ? round(ttmRevenueGrowth, 1) : null,
    ttmOperatingGrowth: Number.isFinite(ttmOperatingGrowth) ? round(ttmOperatingGrowth, 1) : null,
    oneOffSpikePenalty: round(oneOffSpikePenalty, 1),
  };
}

function detectOneOffSpikePenalty(rows) {
  const q = (rows || []).slice(-8);
  if (q.length < 5) return 0;
  const ops = q.map((x) => Number(x.operatingIncome)).filter((x) => Number.isFinite(x) && x > 0);
  if (ops.length < 4) return 0;
  const sorted = [...ops].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const max = Math.max(...ops);
  if (!(med > 0) || max < med * 2.2) return 0;
  const idx = q.findIndex((x) => Number(x.operatingIncome) === max);
  const next = idx >= 0 && idx < q.length - 1 ? Number(q[idx + 1].operatingIncome) : null;
  if (Number.isFinite(next) && next < max * 0.65) return 8;
  return 4;
}

function positiveTransitionRatio(values) {
  const v = (values || []).map(Number).filter(Number.isFinite);
  if (v.length < 2) return 0.5;
  let n = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[i - 1]) n++;
  return n / (v.length - 1);
}

function linearSlopePct(values) {
  const v = (values || []).map(Number).filter(Number.isFinite);
  if (v.length < 2) return null;
  const n = v.length;
  const xMean = (n - 1) / 2;
  const yMean = v.reduce((a, b) => a + b, 0) / n;
  if (!Number.isFinite(yMean) || yMean === 0) return null;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (v[i] - yMean); den += (i - xMean) ** 2; }
  return den ? (num / den) / Math.abs(yMean) * 100 : null;
}

function marginPct(op, revenue) {
  const o = Number(op), r = Number(revenue);
  return Number.isFinite(o) && Number.isFinite(r) && r !== 0 ? (o / r) * 100 : null;
}

function pctChange(current, previous) {
  const c = Number(current), p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / Math.abs(p)) * 100;
}

function sumValues(rows, key) {
  const nums = (rows || []).map((x) => Number(x?.[key])).filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

function firstFinite(...values) {
  for (const value of values) if (Number.isFinite(value)) return value;
  return null;
}

function gradeFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "-";
  if (n >= 88) return "S";
  if (n >= 80) return "A+";
  if (n >= 72) return "A";
  if (n >= 62) return "B";
  return "C";
}

function cagrPercent(values) {
  const nums = (values || []).map(Number);
  if (nums.length < 2) return null;
  const first = nums[0];
  const last = nums.at(-1);
  const periods = nums.length - 1;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0 || periods <= 0) return null;
  return (Math.pow(last / first, 1 / periods) - 1) * 100;
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

// -----------------------------------------------------------------------------
// v1.0 · Loopera's Advice
// 공개된 연구 철학(Hypothesis-driven / Evidence-gated / Research Memory)을
// 참고해 독립적으로 구현한 결정론적 검증 계층입니다. 외부 프로젝트 코드는 복사하지 않습니다.
// -----------------------------------------------------------------------------
async function dartResearchSnapshot(env, stockCode) {
  const map = await dartCorpMap(env);
  const corp = map[stockCode];
  if (!corp?.corpCode) {
    return { available: false, corpCode: null, message: "DART 기업고유번호 매핑 없음" };
  }

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  const candidates = [];
  // 정기보고서 제출 가능 시점을 보수적으로 잡고, 실제 미제출이면 다음 후보로 폴백합니다.
  if (month > 11 || (month === 11 && day >= 15)) candidates.push({ year, code: "11014", label: `${year} 3분기` });
  if (month > 8 || (month === 8 && day >= 15)) candidates.push({ year, code: "11012", label: `${year} 반기` });
  if (month > 5 || (month === 5 && day >= 15)) candidates.push({ year, code: "11013", label: `${year} 1분기` });
  candidates.push({ year: year - 1, code: "11011", label: `${year - 1} 사업연도` });
  candidates.push({ year: year - 2, code: "11011", label: `${year - 2} 사업연도` });

  let lastMessage = "사용 가능한 재무제표 없음";
  for (const report of candidates) {
    for (const fsDiv of ["CFS", "OFS"]) {
      const qs = new URLSearchParams({
        crtfc_key: bindingValue(env, "DART_API_KEY"),
        corp_code: corp.corpCode,
        bsns_year: String(report.year),
        reprt_code: report.code,
        fs_div: fsDiv,
      });
      let data;
      try { data = await dartJson(`${DART_BASE}/fnlttSinglAcntAll.json?${qs}`, "DART 전체재무제표"); }
      catch (error) { lastMessage = safeErrorMessage(error); continue; }
      if (data.status === "013") { lastMessage = `${report.label} ${fsDiv}: 조회 데이터 없음`; continue; }
      if (data.status && data.status !== "000") { lastMessage = `${data.status}: ${data.message || "DART 오류"}`; continue; }
      const rows = Array.isArray(data.list) ? data.list : [];
      if (!rows.length) continue;

      const revenue = dartAccountAmount(rows, [/^매출액$/, /수익\(매출액\)/, /^영업수익$/, /^매출$/]);
      const operatingIncome = dartAccountAmount(rows, [/^영업이익/, /^영업손익/]);
      const netIncome = dartAccountAmount(rows, [/당기순이익/, /분기순이익/, /반기순이익/, /연결당기순이익/]);
      const operatingCashFlow = dartAccountAmount(rows, [/영업활동.*현금흐름/, /영업활동으로.*현금흐름/]);
      const inventory = dartAccountAmount(rows, [/^재고자산$/]);
      const receivables = dartAccountAmount(rows, [/매출채권/, /매출채권및기타채권/, /매출채권 및 기타채권/]);
      const cash = dartAccountAmount(rows, [/현금및현금성자산/, /현금 및 현금성자산/]);
      const totalAssets = dartAccountAmount(rows, [/^자산총계$/]);
      const totalLiabilities = dartAccountAmount(rows, [/^부채총계$/]);
      const totalEquity = dartAccountAmount(rows, [/^자본총계$/]);
      const cashConversionOperating = Number.isFinite(operatingCashFlow) && Number.isFinite(operatingIncome) && operatingIncome > 0
        ? operatingCashFlow / operatingIncome : null;
      const cashConversionNet = Number.isFinite(operatingCashFlow) && Number.isFinite(netIncome) && netIncome > 0
        ? operatingCashFlow / netIncome : null;
      const workingCapitalToRevenue = Number.isFinite(revenue) && revenue > 0 && (Number.isFinite(inventory) || Number.isFinite(receivables))
        ? ((Number(inventory) || 0) + (Number(receivables) || 0)) / revenue : null;

      return {
        available: true,
        corpCode: corp.corpCode,
        corpName: corp.corpName || null,
        reportYear: report.year,
        reportCode: report.code,
        reportLabel: report.label,
        fsDiv,
        revenue,
        operatingIncome,
        netIncome,
        operatingCashFlow,
        inventory,
        receivables,
        cash,
        totalAssets,
        totalLiabilities,
        totalEquity,
        cashConversionOperating: Number.isFinite(cashConversionOperating) ? round(cashConversionOperating, 2) : null,
        cashConversionNet: Number.isFinite(cashConversionNet) ? round(cashConversionNet, 2) : null,
        workingCapitalToRevenue: Number.isFinite(workingCapitalToRevenue) ? round(workingCapitalToRevenue, 3) : null,
        message: `${report.label} ${fsDiv === "CFS" ? "연결" : "별도"} 재무제표 원문 대조`,
      };
    }
  }
  return { available: false, corpCode: corp.corpCode, corpName: corp.corpName || null, message: lastMessage };
}

function dartAccountAmount(rows, patterns) {
  for (const row of rows || []) {
    const name = String(row.account_nm || "").replace(/\s+/g, "").trim();
    if (!name || !(patterns || []).some((rx) => rx.test(name))) continue;
    const values = [row.thstrm_amount, row.thstrm_add_amount, row.frmtrm_amount, row.frmtrm_add_amount];
    for (const value of values) {
      const parsed = dartAmount(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function dartAmount(value) {
  if (value === null || value === undefined || value === "") return null;
  const clean = String(value).replace(/,/g, "").replace(/[()]/g, (m) => m === "(" ? "-" : "").replace(/\s+/g, "");
  const normalized = clean.endsWith(")") ? clean.slice(0, -1) : clean;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function buildLooperaAdvice({ code, candidate = {}, member = {}, sector = {}, peerContext = {}, accounting = {} }) {
  const q = candidate.quarterlyMetrics || {};
  const valuation = candidate.valuation || {};
  const risk = candidate.risk || {};
  const disclosureItems = risk?.disclosure?.items || [];
  const quality = finiteOr(candidate.qualityScore, candidate.score, 0);
  const value = finiteOr(candidate.valueScore, 0);
  const accumulation = finiteOr(candidate.accumulationScore, candidate.accumulation?.score, 0);
  const debt = numOrNull(candidate.debtRatio);
  const roe = numOrNull(candidate.roe);
  const price1y = numOrNull(candidate.price1yChangePct);
  const position52 = numOrNull(valuation.position52);
  const riskPenalty = Math.max(0, finiteOr(candidate.riskPenalty, risk.penalty, 0));
  const annualCount = Array.isArray(candidate.annual) ? candidate.annual.length : 0;
  const quarterCount = Math.max(
    Array.isArray(candidate.quarterly) ? candidate.quarterly.length : 0,
    Number(q.trainCount || 0) + Number(q.testCount || 0)
  );

  const growthStrong = Number(q.ttmRevenueGrowth) > 0 && Number(q.ttmOperatingGrowth) > 0;
  const marginImproving = Number(q.testMarginSlopePpPerQuarter) >= 0 && Number(q.testMarginTransitionRatio) >= 50;
  const cheapEvidence = value >= 65 || (Number.isFinite(position52) && position52 <= 45) || (growthStrong && Number.isFinite(price1y) && price1y < 0);
  const accumulationStrong = accumulation >= 68;
  const stable = (debt == null || debt < 150) && (roe == null || roe > 0);
  const sectorTrend = numOrNull(sector?.trend?.score ?? sector?.score);
  const sectorSupport = sectorTrend == null || sectorTrend >= 60;
  const trainPass = q.trainPass === true;
  const testPass = q.testPass === true;
  const spikePenalty = Math.max(0, Number(q.oneOffSpikePenalty || 0));

  let coveragePoints = 0;
  coveragePoints += Math.min(30, quarterCount / 8 * 30);
  coveragePoints += Math.min(18, annualCount / 3 * 18);
  coveragePoints += valuation && Object.keys(valuation).length ? 15 : 0;
  coveragePoints += candidate.accumulationScore != null ? 12 : 0;
  coveragePoints += candidate.riskPenalty != null ? 10 : 0;
  coveragePoints += accounting.available ? 15 : 5;
  const coverageScore = clamp100(coveragePoints);

  // 라이브 화면은 '현재 공개자료'만 사용한다. 과거 시점별 공개일 재구성이 없으므로 Timing gate는 통과가 아니라 주의 수준으로 제한한다.
  let timingScore = 68;
  if (quarterCount >= 8) timingScore += 8;
  if (accounting.available) timingScore += 5;
  if (q.testCount >= 4) timingScore += 4;
  timingScore = Math.min(82, timingScore);

  let accountingScore = accounting.available ? 68 : 60;
  const cfoOp = numOrNull(accounting.cashConversionOperating);
  const cfoNet = numOrNull(accounting.cashConversionNet);
  if (Number.isFinite(cfoOp)) {
    if (cfoOp >= 1.0) accountingScore += 18;
    else if (cfoOp >= 0.7) accountingScore += 12;
    else if (cfoOp >= 0.4) accountingScore += 2;
    else if (cfoOp >= 0) accountingScore -= 15;
    else accountingScore -= 25;
  }
  if (Number.isFinite(cfoNet) && cfoNet >= 1) accountingScore += 6;
  if (Number.isFinite(accounting.operatingIncome) && accounting.operatingIncome > 0 && Number.isFinite(accounting.operatingCashFlow) && accounting.operatingCashFlow < 0) accountingScore -= 18;
  accountingScore = clamp100(accountingScore);

  const logicDimensions = [growthStrong, marginImproving, cheapEvidence, accumulationStrong, stable, sectorSupport].filter(Boolean).length;
  let logicScore = 40 + logicDimensions * 9;
  if (growthStrong && price1y != null && price1y < 0) logicScore += 6;
  if (!growthStrong && value >= 75) logicScore -= 8; // 싸기만 한 가치함정 방지
  logicScore = clamp100(logicScore);

  let robustnessScore = 45;
  if (trainPass) robustnessScore += 17;
  if (testPass) robustnessScore += 22;
  if (Number(q.yoyRevenuePositiveRatio) >= 75) robustnessScore += 7;
  if (Number(q.yoyOperatingPositiveRatio) >= 75) robustnessScore += 7;
  robustnessScore -= spikePenalty * 1.8;
  if (Number(candidate.revenueCagr) > 0) robustnessScore += 4;
  if (Number(candidate.operatingCagr) > 0) robustnessScore += 4;
  robustnessScore = clamp100(robustnessScore);

  const peerQ = numOrNull(peerContext.qualityMedian);
  const peerV = numOrNull(peerContext.valueMedian);
  const peerA = numOrNull(peerContext.accumulationMedian);
  let independentDimensions = 0;
  if (peerQ == null ? quality >= 65 : quality >= peerQ + 3) independentDimensions++;
  if (peerV == null ? value >= 65 : value >= peerV + 3) independentDimensions++;
  if (peerA == null ? accumulationStrong : accumulation >= peerA + 4) independentDimensions++;
  if (growthStrong && Number.isFinite(price1y) && price1y < 0) independentDimensions++;
  if (accountingScore >= 70) independentDimensions++;
  if (riskPenalty === 0) independentDimensions++;
  let incrementalScore = clamp100(36 + independentDimensions * 10);
  if (logicDimensions < 3) incrementalScore = Math.min(incrementalScore, 58);

  const supportEvidence = [];
  const counterEvidence = [];
  if (growthStrong) supportEvidence.push(`TTM 매출 ${signedNumber(q.ttmRevenueGrowth, "%")} · 영업이익 ${signedNumber(q.ttmOperatingGrowth, "%")} 성장`);
  else counterEvidence.push("TTM 매출·영업이익이 동시에 성장한다는 증거가 부족합니다.");
  if (testPass) supportEvidence.push("최근 4분기 Test 구간의 매출·영업이익률 지속성 검증 통과");
  else counterEvidence.push("최근 4분기 Test 구간이 성장 지속성 기준을 완전히 통과하지 못했습니다.");
  if (trainPass) supportEvidence.push("과거 Train 구간에서도 성장 방향이 유지되었습니다.");
  else if (q.trainPass === false) counterEvidence.push("과거 Train 구간에서는 같은 성장 패턴이 재현되지 않았습니다.");
  if (cheapEvidence) supportEvidence.push(`Value ${round(value, 1)}/100 · 52주 위치 ${position52 == null ? "자료없음" : `${round(position52, 1)}%`} · 1년 주가 ${price1y == null ? "자료없음" : signedNumber(price1y, "%")}`);
  else counterEvidence.push("현재 가격이 동종업계·52주 위치·실적 대비 충분히 싸다는 증거가 약합니다.");
  if (accumulationStrong) supportEvidence.push(`외국인·기관/거래량 매집 ${round(accumulation, 1)}/100`);
  else counterEvidence.push("외국인·기관의 지속적 매집 신호가 강하지 않습니다.");
  if (accounting.available && Number.isFinite(cfoOp)) {
    if (cfoOp >= 0.7) supportEvidence.push(`DART 현금전환: 영업현금흐름/영업이익 ${round(cfoOp, 2)}배`);
    else counterEvidence.push(`DART 현금전환이 약함: 영업현금흐름/영업이익 ${round(cfoOp, 2)}배`);
  } else counterEvidence.push("DART 현금흐름 원문 검증 자료가 충분하지 않습니다.");
  if (riskPenalty > 0) counterEvidence.push(`최근 공시·뉴스 위험 감점 ${round(riskPenalty, 1)}점`);
  if (spikePenalty > 0) counterEvidence.push(`한 분기 일회성 실적 급증 가능성 페널티 ${round(spikePenalty, 1)}점`);

  const criticalRisk = disclosureItems.some((x) => x.category === "중대 리스크" || Number(x.weight) >= 10);
  const gates = [
    evidenceGate("coverage", "데이터·Coverage", coverageScore, coverageScore >= 72 ? "핵심 입력 데이터가 충분합니다." : "분기·연간·수급·공시 중 일부 데이터가 부족합니다."),
    evidenceGate("timing", "정보시점", timingScore, "현재 공개 API 데이터만 사용합니다. 과거 point-in-time 공개일 재구성은 아직 백테스트 단계가 아닙니다."),
    evidenceGate("accounting", "회계정의·현금", accountingScore, accounting.available ? accounting.message : "DART 원문 재무제표 대조가 불완전합니다."),
    evidenceGate("logic", "경제적 논리", logicScore, `${logicDimensions}/6개 독립 논리 축이 같은 방향을 지지합니다.`),
    evidenceGate("robustness", "Train→Test 안정성", robustnessScore, `Train ${q.trainPass === true ? "통과" : q.trainPass === false ? "미통과" : "자료부족"} · Test ${q.testPass === true ? "통과" : q.testPass === false ? "미통과" : "자료부족"} · Spike -${round(spikePenalty, 1)}`),
    evidenceGate("incremental", "독립 증거 프록시", incrementalScore, `${independentDimensions}/6개 독립 증거축. 실제 Incremental Residual IC가 아니라 동종후보 대비 증거 다양성 프록시입니다.`),
  ];
  // point-in-time 패널을 재구성하지 않은 라이브 화면에서는 Timing을 완전 통과로 과장하지 않습니다.
  const timingGate = gates.find((g) => g.key === "timing");
  if (timingGate) timingGate.status = "watch";

  let rawScore = coverageScore * 0.10 + timingScore * 0.10 + accountingScore * 0.15 + logicScore * 0.25 + robustnessScore * 0.25 + incrementalScore * 0.15;
  rawScore -= Math.min(20, riskPenalty * 0.75);
  if (spikePenalty >= 8) rawScore -= 4;
  const stopGate = gates.some((g) => g.status === "stop");
  if (criticalRisk || stopGate) rawScore = Math.min(rawScore, 59);
  const adviceScore = round(clamp100(rawScore), 1);
  const decision = (criticalRisk || stopGate) ? "보류" : adviceScore >= 82 ? "우선 검토" : adviceScore >= 72 ? "추가 검증" : adviceScore >= 62 ? "관찰" : "보류";

  let hypothesisTitle = "증거 부족 · 추가 관찰";
  let mechanism = "좋은 숫자 한두 개가 아니라 서로 독립적인 실적·가격·수급·회계 증거가 같은 방향으로 모이는지 더 확인해야 합니다.";
  if (growthStrong && Number.isFinite(price1y) && price1y < 0) {
    hypothesisTitle = "실적 성장 대비 가격 미반영";
    mechanism = "최근 실적과 영업이익이 개선되는 동안 1년 주가가 낮아져 있다면, 펀더멘털 변화가 가격에 충분히 반영되지 않았을 가능성을 검증할 가치가 있습니다.";
  } else if (trainPass && testPass) {
    hypothesisTitle = "분기 성장 지속성";
    mechanism = "과거 Train 구간과 최근 Test 구간에서 모두 성장 방향이 유지되어 단일 분기 이벤트보다 반복 가능한 영업 개선일 가능성이 높습니다.";
  } else if (accumulationStrong) {
    hypothesisTitle = "수급 선행 가능성";
    mechanism = "가격보다 외국인·기관 누적매수와 거래량 구조가 먼저 개선되는지 확인해 가격 반영 이전의 수급 변화를 가설로 둡니다.";
  } else if (roe != null && roe >= 10 && value >= 65) {
    hypothesisTitle = "자본효율 대비 저평가";
    mechanism = "ROE가 유지되는 가운데 PBR·PER·52주 위치 등 가격 지표가 동종기업 대비 낮다면 가치함정이 아닌 가격 괴리인지 확인합니다.";
  }

  const competingMechanisms = [
    "실적 개선이 구조적 성장보다 기저효과·원가 변동·일회성 수주에 의한 것일 수 있습니다.",
    "주가 하락은 저평가가 아니라 시장이 아직 반영하지 않은 업황·회계·지배구조 악화를 선반영했을 수 있습니다.",
    "외국인·기관 순매수는 기업 고유 판단이 아니라 지수 리밸런싱·패시브 자금·환율 영향일 수 있습니다.",
    "낮은 PBR/PER은 성장 둔화나 자본효율 하락을 반영한 가치함정일 수 있습니다.",
  ];
  if (criticalRisk) competingMechanisms.unshift("중대 공시 리스크가 펀더멘털·가격 괴리보다 우선합니다.");

  const failureConditions = [
    "다음 2개 분기 중 매출 또는 영업이익률이 연속 악화",
    "TTM 영업이익 성장률이 0% 이하로 전환",
    "외국인·기관 20일 누적 수급이 동반 순매도로 전환",
    "유상증자·대규모 CB/BW·감사·횡령/배임 등 중대 공시 발생",
    "추정 적정가 괴리가 해소되거나 52주 상단으로 급격히 재평가",
    "영업이익은 늘지만 영업현금흐름이 지속적으로 따라오지 못함",
  ];

  const accountingSummary = accounting.available ? {
    label: accounting.message,
    reportLabel: accounting.reportLabel,
    fsDiv: accounting.fsDiv,
    cashConversionOperating: accounting.cashConversionOperating,
    cashConversionNet: accounting.cashConversionNet,
    workingCapitalToRevenue: accounting.workingCapitalToRevenue,
    operatingCashFlow: accounting.operatingCashFlow,
    operatingIncome: accounting.operatingIncome,
  } : { label: accounting.message || "DART 회계 원문 검증 자료 없음" };

  return {
    code,
    name: member.name || candidate.name || code,
    englishName: member.englishName || member.nameEn || "",
    market: member.market || "",
    sector: sector.name || "",
    score: adviceScore,
    decision,
    criticalRisk,
    hypothesis: { title: hypothesisTitle, mechanism, expectedDirection: "향후 6~12개월 상대수익률 개선 가능성 — 실제 예측력은 별도 OOS 백테스트 필요" },
    gates,
    supportEvidence: supportEvidence.slice(0, 8),
    counterEvidence: counterEvidence.slice(0, 8),
    researchContract: {
      phenomenon: hypothesisTitle,
      hypothesis: mechanism,
      expectedDirection: "후보군 내 상대적 우위",
      competingMechanisms,
      failureConditions,
      observableEvidence: ["분기 매출·영업이익률", "TTM 성장", "ROE/PBR·52주 위치", "외국인·기관 누적수급", "가격·거래량 구조", "DART 공시·현금흐름"],
    },
    accountingSummary,
    limitations: [
      "이 점수는 실시간 후보 검증용이며 매수·매도 신호가 아닙니다.",
      "현재 독립 증거 Gate는 실제 Incremental Residual IC가 아닌 프록시입니다.",
      "Rank IC·Sharpe·MDD·업종/시총 중립화·walk-forward·독립 OOS는 과거 시점별 패널 DB 구축 후에만 유효하게 계산할 수 있습니다.",
      "DART 최신 재무 원문은 제출 시점·연결/별도 기준 차이 때문에 KIS 분기 시계열과 완전히 같은 단위가 아닐 수 있습니다.",
    ],
  };
}

function evidenceGate(key, name, score, reason) {
  const s = round(clamp100(score), 1);
  return { key, name, score: s, status: s >= 72 ? "pass" : s >= 58 ? "watch" : "stop", reason };
}

function finiteOr(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function clamp100(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function signedNumber(value, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n > 0 ? "+" : ""}${round(n, 1)}${suffix}`;
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
        "user-agent": "FF-Value-Hunter/1.0 (Cloudflare Worker)",
      },
    });
  } catch (error) {
    throw new Error(`OpenDART 네트워크 오류: ${safeErrorMessage(error)}`);
  }

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get("location") || "";
    if (/error1\.html/i.test(location)) {
      throw new Error("OpenDART가 Cloudflare Worker 요청을 오류 페이지로 리디렉션했습니다. v1.0에서는 이 오류가 반복되지 않도록 리디렉션을 중단하고, 기업명·업종은 KIS로 대체합니다.");
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

function assertKrxDate(basDd) {
  if (!/^\d{8}$/.test(String(basDd))) {
    const error = new Error("KRX 날짜는 YYYYMMDD 형식이어야 합니다.");
    error.status = 400;
    throw error;
  }
}


async function dartCorpMap(env) {
  const cached = await cacheJsonGet(DART_CORP_CACHE_URL);
  if (cached?.byStock && Object.keys(cached.byStock).length > 1000) return cached.byStock;
  const key = bindingValue(env, "DART_API_KEY");
  const url = `${DART_BASE}/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { redirect: "manual", headers: { accept: "application/zip,application/octet-stream,*/*", "user-agent": "FF-Value-Hunter/1.0" } });
  if (!res.ok) throw new Error(`DART 고유번호 다운로드 실패 HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const xmlBytes = await unzipZipEntry(bytes, ".xml");
  const xml = new TextDecoder("utf-8").decode(xmlBytes);
  const byStock = {};
  const listRe = /<list>([\s\S]*?)<\/list>/g;
  let m;
  while ((m = listRe.exec(xml))) {
    const block = m[1];
    const stock = xmlTag(block, "stock_code").trim();
    const corp = xmlTag(block, "corp_code").trim();
    if (/^\d{6}$/.test(stock) && /^\d{8}$/.test(corp)) {
      byStock[stock] = { corpCode: corp, corpName: xmlTag(block, "corp_name").trim(), engName: xmlTag(block, "corp_eng_name").trim() };
    }
  }
  await cacheJsonPut(DART_CORP_CACHE_URL, { byStock, updatedAt: new Date().toISOString() }, 60 * 60 * 24);
  return byStock;
}

function xmlTag(block, tag) {
  const m = String(block || "").match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeXml(m[1]) : "";
}

function decodeXml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function dartDisclosureRisk(env, stockCode) {
  const map = await dartCorpMap(env);
  const corp = map[stockCode];
  if (!corp?.corpCode) return { available: false, penalty: 0, items: [], corpCode: null, message: "DART 고유번호 매핑 없음" };
  const end = new Date();
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 370);
  const qs = new URLSearchParams({
    crtfc_key: bindingValue(env, "DART_API_KEY"), corp_code: corp.corpCode,
    bgn_de: yyyymmdd(start), end_de: yyyymmdd(end), sort: "date", sort_mth: "desc", page_no: "1", page_count: "100",
  });
  const data = await dartJson(`${DART_BASE}/list.json?${qs}`, "DART 공시검색");
  if (data.status && !["000", "013"].includes(data.status)) throw new Error(`DART 공시검색 ${data.status}: ${data.message || "오류"}`);
  const rows = Array.isArray(data.list) ? data.list : [];
  const risky = [];
  const seenRisk = new Set();
  let penalty = 0;
  for (const row of rows) {
    const title = String(row.report_nm || "");
    const hit = disclosureRiskWeight(title);
    if (!hit.weight) continue;
    const dedupeKey = `${hit.category}:${title.replace(/\[[^\]]*정정[^\]]*\]|정정/g, "").replace(/\s+/g, "")}`;
    if (seenRisk.has(dedupeKey)) continue;
    seenRisk.add(dedupeKey);
    penalty += hit.weight;
    risky.push({ date: row.rcept_dt || null, title, category: hit.category, weight: hit.weight, receiptNo: row.rcept_no || null });
  }
  penalty = Math.min(20, penalty);
  return { available: true, penalty, items: risky.slice(0, 12), corpCode: corp.corpCode, corpName: corp.corpName, message: risky.length ? "최근 1년 위험 공시 감지" : "최근 1년 주요 위험공시 미감지" };
}

function disclosureRiskWeight(title) {
  const t = String(title || "").replace(/\s+/g, "");
  const rules = [
    [/횡령|배임|감사의견거절|상장폐지|파산|회생절차|부도|영업정지/, 10, "중대 리스크"],
    [/감자결정|자본감소/, 7, "감자"],
    [/유상증자결정|유무상증자결정/, 5, "유상증자"],
    [/전환사채권발행|신주인수권부사채권발행|교환사채권발행/, 4, "메자닌·희석"],
    [/최대주주변경|경영권분쟁/, 4, "지배구조"],
    [/소송|과징금|벌금|압수수색/, 3, "법률 리스크"],
  ];
  for (const [re, weight, category] of rules) if (re.test(t)) return { weight, category };
  return { weight: 0, category: null };
}

async function dartJson(url, label = "OpenDART") {
  const res = await fetch(url, { redirect: "manual", headers: { accept: "application/json,*/*", "user-agent": "FF-Value-Hunter/1.0" } });
  if ([301,302,303,307,308].includes(res.status)) throw new Error(`${label} 리디렉션 오류`);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { throw new Error(`${label} JSON 응답 아님`); }
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${sanitizeText(data.message || "요청 실패")}`);
  return data;
}

async function fetchNewsRisk(companyName) {
  const riskTerms = "유상증자 OR 횡령 OR 배임 OR 구속 OR 압수수색 OR 경영권분쟁 OR 상장폐지 OR 영업정지 OR 회생절차 OR 감사의견";
  const q = `\"${companyName}\" (${riskTerms})`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { headers: { "user-agent": "FF-Value-Hunter/1.0" } });
  if (!res.ok) throw new Error(`뉴스 RSS HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < 12) {
    const block = m[1];
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").replace(/<!\[CDATA\[|\]\]>/g, "");
    const pubDate = decodeXml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    if (title) items.push({ title, pubDate, link });
  }
  const severe = /횡령|배임|구속|상장폐지|회생절차|감사의견거절|영업정지/;
  const medium = /유상증자|경영권분쟁|압수수색|과징금/;
  let penalty = 0;
  for (const it of items) { if (severe.test(it.title)) penalty += 3; else if (medium.test(it.title)) penalty += 1.5; }
  penalty = Math.min(5, penalty);
  return { available: true, penalty: round(penalty, 1), headlines: items.slice(0, 8), message: items.length ? "위험 키워드 뉴스 검색 결과 있음" : "위험 키워드 뉴스 미감지", note: "뉴스는 제목 기반 보조신호이며 오탐 가능성이 있어 공시보다 낮은 가중치를 적용합니다." };
}

async function unzipZipEntry(bytes, extension) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => view.getUint16(o, true), u32 = (o) => view.getUint32(o, true);
  const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) { if (u32(i) === EOCD) { eocd = i; break; } }
  if (eocd < 0) throw new Error("ZIP 중앙 디렉터리 없음");
  const total = u16(eocd + 10); let pos = u32(eocd + 16); const dec = new TextDecoder("utf-8");
  for (let i = 0; i < total; i++) {
    if (pos + 46 > bytes.length || u32(pos) !== CENTRAL) break;
    const method = u16(pos + 10), size = u32(pos + 20), nameLen = u16(pos + 28), extraLen = u16(pos + 30), commentLen = u16(pos + 32), local = u32(pos + 42);
    const name = dec.decode(bytes.slice(pos + 46, pos + 46 + nameLen));
    if (name.toLowerCase().endsWith(String(extension).toLowerCase())) {
      if (u32(local) !== LOCAL) throw new Error("ZIP 로컬 헤더 오류");
      const ln = u16(local + 26), le = u16(local + 28), start = local + 30 + ln + le;
      const compressed = bytes.slice(start, start + size);
      if (method === 0) return compressed;
      if (method !== 8) throw new Error(`지원하지 않는 ZIP 압축 방식 ${method}`);
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP 안에 ${extension} 파일이 없습니다.`);
}

async function krxGet(env, path, basDd, label) {
  assertKrxDate(basDd);
  return fetchJson(`${KRX_BASE}${path}?basDd=${basDd}`, {
    headers: { AUTH_KEY: bindingValue(env, "KRX_AUTH_KEY") },
  }, label);
}

async function krxKospiDaily(env, basDd) {
  return krxGet(env, "/sto/stk_bydd_trd", basDd, "KRX KOSPI daily");
}

async function krxKosdaqDaily(env, basDd) {
  return krxGet(env, "/sto/ksq_bydd_trd", basDd, "KRX KOSDAQ daily");
}

async function krxKospiBaseInfo(env, basDd) {
  return krxGet(env, "/sto/stk_isu_base_info", basDd, "KRX KOSPI base info");
}

async function krxKosdaqBaseInfo(env, basDd) {
  return krxGet(env, "/sto/ksq_isu_base_info", basDd, "KRX KOSDAQ base info");
}

async function krxKospiIndexDaily(env, basDd) {
  return krxGet(env, "/idx/kospi_dd_trd", basDd, "KRX KOSPI index daily");
}

async function krxKosdaqIndexDaily(env, basDd) {
  return krxGet(env, "/idx/kosdaq_dd_trd", basDd, "KRX KOSDAQ index daily");
}

function recentKrxDateCandidates(max = 10) {
  const out = [];
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  while (out.length < max) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) out.push(yyyymmdd(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

async function findLatestKrxTradingDate(env) {
  let lastError = null;
  for (const date of recentKrxDateCandidates(8)) {
    try {
      const data = await krxKospiDaily(env, date);
      if (Array.isArray(data?.OutBlock_1) && data.OutBlock_1.length) return date;
    } catch (error) {
      lastError = error;
      if (/401|Unauthorized API Call/i.test(safeErrorMessage(error))) throw error;
    }
  }
  if (lastError) throw lastError;
  throw new Error("최근 KRX 거래일 데이터를 찾지 못했습니다.");
}

function krxCode(row) {
  const raw = String(row?.ISU_SRT_CD || row?.ISU_CD || "").trim();
  const m = raw.match(/(\d{6})(?!.*\d)/);
  return m ? m[1] : "";
}

function normalizeKrxDailyRow(row, market) {
  const code = krxCode(row);
  if (!code) return null;
  return {
    code,
    market,
    name: String(row?.ISU_NM || "").trim(),
    close: numOrNull(row?.TDD_CLSPRC),
    dayPct: numOrNull(row?.FLUC_RT),
    volume: numOrNull(row?.ACC_TRDVOL),
    tradeValueWon: numOrNull(row?.ACC_TRDVAL),
    marketCapWon: numOrNull(row?.MKTCAP),
    listedShares: numOrNull(row?.LIST_SHRS),
  };
}

async function loadKrxMarketData(env) {
  const cached = await cacheJsonGet(KRX_MARKET_CACHE_URL);
  if (cached?.date && cached?.byCode) return cached;

  const recentFailure = await cacheJsonGet(KRX_FAILURE_CACHE_URL);
  if (recentFailure?.at && Date.now() - Number(recentFailure.at) < 2 * 60 * 1000) {
    throw new Error(recentFailure.message || "KRX API가 잠시 사용 불가합니다.");
  }

  try {
    const date = await findLatestKrxTradingDate(env);
    const [kospiDaily, kosdaqDaily, kospiBase, kosdaqBase, kospiIndex, kosdaqIndex] = await Promise.all([
      krxKospiDaily(env, date),
      krxKosdaqDaily(env, date),
      krxKospiBaseInfo(env, date),
      krxKosdaqBaseInfo(env, date),
      krxKospiIndexDaily(env, date),
      krxKosdaqIndexDaily(env, date),
    ]);

    const byCode = {};
    for (const row of kospiDaily?.OutBlock_1 || []) {
      const item = normalizeKrxDailyRow(row, "KOSPI");
      if (item) byCode[item.code] = item;
    }
    for (const row of kosdaqDaily?.OutBlock_1 || []) {
      const item = normalizeKrxDailyRow(row, "KOSDAQ");
      if (item) byCode[item.code] = item;
    }
    const baseRows = [
      ...(kospiBase?.OutBlock_1 || []),
      ...(kosdaqBase?.OutBlock_1 || []),
    ];
    for (const row of baseRows) {
      const code = krxCode(row);
      if (!code) continue;
      byCode[code] ||= { code };
      byCode[code].englishName = String(row?.ISU_ENG_NM || "").trim() || null;
      byCode[code].listedDate = String(row?.LIST_DD || "").trim() || null;
      byCode[code].securityGroup = String(row?.SECUGRP_NM || "").trim() || null;
    }

    const payload = {
      date,
      byCode,
      rows: Object.keys(byCode).length,
      indices: {
        kospi: (kospiIndex?.OutBlock_1 || []).slice(0, 80),
        kosdaq: (kosdaqIndex?.OutBlock_1 || []).slice(0, 80),
      },
      source: "KRX 통계정보",
    };
    await cacheJsonPut(KRX_MARKET_CACHE_URL, payload, 60 * 60 * 4);
    return payload;
  } catch (error) {
    await cacheJsonPut(KRX_FAILURE_CACHE_URL, { at: Date.now(), message: safeErrorMessage(error) }, 60 * 2);
    throw error;
  }
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
      open: round(row.open),
      high: round(row.high),
      low: round(row.low),
      ma20: subset.length >= 20 ? round(sma(subset, 20)) : null,
      ma60: subset.length >= 60 ? round(sma(subset, 60)) : null,
      ma120: subset.length >= 120 ? round(sma(subset, 120)) : null,
      volume: round(row.volume),
    };
  }).slice(-270);
  const yearAgo = clean[Math.max(0, clean.length - 253)]?.close;
  const price1yChangePct = Number.isFinite(yearAgo) && yearAgo > 0 ? pct(last.close, yearAgo) : null;

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
    price1yChangePct: Number.isFinite(price1yChangePct) ? round(price1yChangePct, 2) : null,
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


function analyzeAccumulation(technical, supply) {
  const rows = (technical?.series || []).slice(-60);
  if (!rows.length) return { score: Number(supply?.score || 0), label: supply?.label || "자료 부족", signals: [], penalties: [] };
  const last20 = rows.slice(-20);
  const last5 = rows.slice(-5);
  const prev20 = rows.slice(-25, -5);
  const avg20Volume = average(last20.map((x) => Number(x.volume)).filter(Number.isFinite));
  const avg5Volume = average(last5.map((x) => Number(x.volume)).filter(Number.isFinite));
  const prev20Volume = average(prev20.map((x) => Number(x.volume)).filter(Number.isFinite));
  const closeNow = Number(rows.at(-1)?.close);
  const close20Ago = Number(rows[Math.max(0, rows.length - 21)]?.close);
  const price20 = Number.isFinite(closeNow) && Number.isFinite(close20Ago) && close20Ago > 0 ? ((closeNow - close20Ago) / close20Ago) * 100 : null;
  const volumeRamp = Number.isFinite(avg5Volume) && Number.isFinite(prev20Volume) && prev20Volume > 0 ? (avg5Volume / prev20Volume) : null;
  const supplyScore = Number(supply?.score || 0);
  let score = supplyScore * 0.62;
  const signals = [];
  const penalties = [];

  const foreign20 = Number(supply?.foreign?.net20d || 0);
  const inst20 = Number(supply?.institution?.net20d || 0);
  const bothBuying = foreign20 > 0 && inst20 > 0;
  if (bothBuying) { score += 8; signals.push("외국인·기관 20일 동반 순매수"); }
  if (Number(supply?.foreign?.exhaustionRateDelta30d) > 0) { score += 6; signals.push("외국인 보유비율 상승"); }

  // 가격이 크게 오르지 않았는데 수급이 쌓이는 경우를 '조용한 매집 후보'로 봅니다.
  if (bothBuying && Number.isFinite(price20) && price20 > -8 && price20 < 8) {
    score += 10; signals.push("가격 횡보권에서 외국인·기관 누적매수");
  }
  // 상승하는데 거래량이 줄고 수급이 플러스면 매도물량 감소(공급 건조) 후보로 봅니다.
  if ((foreign20 > 0 || inst20 > 0) && Number.isFinite(price20) && price20 > 0 && Number.isFinite(avg5Volume) && Number.isFinite(avg20Volume) && avg20Volume > 0 && avg5Volume < avg20Volume * 0.85) {
    score += 7; signals.push("상승 중 거래량 감소 + 수급 양호 (공급 감소 후보)");
  }
  // 거래량이 점진적으로 증가하면서 수급도 동행하는 경우 확인 가점.
  if ((foreign20 > 0 || inst20 > 0) && Number.isFinite(volumeRamp) && volumeRamp >= 1.2 && volumeRamp <= 2.8) {
    score += 7; signals.push(`최근 거래량 증가 ${round(volumeRamp, 2)}배`);
  }

  // 고거래량 윗꼬리/종가 약세는 분배 가능성 페널티. '세력'을 단정하지 않고 경고 신호로만 사용합니다.
  let distributionDays = 0;
  for (const row of last20) {
    const high = Number(row.high), low = Number(row.low), close = Number(row.close), open = Number(row.open), vol = Number(row.volume);
    if (![high, low, close, open, vol].every(Number.isFinite) || high <= low || !(avg20Volume > 0)) continue;
    const closePos = (close - low) / (high - low);
    const upperWick = high - Math.max(open, close);
    const bodyRange = high - low;
    if (vol > avg20Volume * 1.45 && closePos < 0.45 && upperWick / bodyRange > 0.35) distributionDays++;
  }
  if (distributionDays >= 2) {
    const pen = Math.min(14, distributionDays * 4);
    score -= pen; penalties.push(`고거래량 윗꼬리·종가약세 ${distributionDays}일 (-${pen})`);
  }

  score = Math.max(0, Math.min(100, score));
  let label = "관찰";
  if (score >= 82) label = "강한 누적매집 후보";
  else if (score >= 68) label = "매집 우위";
  else if (score < 45) label = "수급 약함";
  return {
    score: round(score, 1), label, signals, penalties,
    price20dPct: Number.isFinite(price20) ? round(price20, 2) : null,
    avgVolume5: Number.isFinite(avg5Volume) ? round(avg5Volume) : null,
    avgVolume20: Number.isFinite(avg20Volume) ? round(avg20Volume) : null,
    volumeRampRatio: Number.isFinite(volumeRamp) ? round(volumeRamp, 2) : null,
    distributionDays20: distributionDays,
    note: "외국인·기관 지속순매수, 외국인 보유비율, 가격-거래량 조합을 함께 평가합니다. 특정 주체의 의도를 단정하지 않는 보조 신호입니다.",
  };
}

function average(values) {
  const a = (values || []).map(Number).filter(Number.isFinite);
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
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
  const price = numOrNull(o.stck_prpr);
  const high52 = firstFinite(numOrNull(o.d250_hgpr), numOrNull(o.w52_hgpr), numOrNull(o.stck_dryy_hgpr));
  const low52 = firstFinite(numOrNull(o.d250_lwpr), numOrNull(o.w52_lwpr), numOrNull(o.stck_dryy_lwpr));
  const position52 = Number.isFinite(price) && Number.isFinite(high52) && Number.isFinite(low52) && high52 > low52
    ? Math.max(0, Math.min(100, ((price - low52) / (high52 - low52)) * 100))
    : null;
  return {
    name: o.hts_kor_isnm || null,
    industry: o.bstp_kor_isnm || null,
    fiscalMonth: normalizeFiscalMonth(o.stac_month),
    price,
    marketCap100MKRW: numOrNull(o.hts_avls),
    per: numOrNull(o.per),
    pbr: numOrNull(o.pbr),
    eps: numOrNull(o.eps),
    bps: numOrNull(o.bps),
    high52,
    low52,
    high52Date: o.d250_hgpr_date || o.w52_hgpr_date || o.dryy_hgpr_date || null,
    low52Date: o.d250_lwpr_date || o.w52_lwpr_date || o.dryy_lwpr_date || null,
    position52: Number.isFinite(position52) ? round(position52, 2) : null,
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

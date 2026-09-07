const $ = (id) => document.getElementById(id);
const accessKey = $("accessKey");
const accessMsg = $("accessMsg");
const apiCards = $("apiCards");
const deployNotice = $("deployNotice");
const result = $("result");
const loading = $("loading");

const providers = [
  { id: "dart", name: "OpenDART", endpoint: "/api/test/dart", detail: "공시·기업정보" },
  { id: "kis", name: "한국투자 KIS", endpoint: "/api/test/kis", detail: "주가·수급·차트·재무" },
  { id: "krx", name: "KRX", endpoint: "/api/test/krx", detail: "공식 시장 데이터" },
  { id: "ecos", name: "한국은행 ECOS", endpoint: "/api/test/ecos", detail: "금리·환율·거시" },
];

let lastAnalysis = null;
let resizeTimer = null;

accessKey.value = sessionStorage.getItem("ff_access_key") || "";

$("saveAccess").addEventListener("click", () => {
  const value = accessKey.value.trim();
  if (value) sessionStorage.setItem("ff_access_key", value);
  else sessionStorage.removeItem("ff_access_key");
  accessMsg.textContent = value
    ? "접속키를 현재 브라우저 세션에 적용했습니다."
    : "접속키를 비웠습니다.";
});

accessKey.addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("saveAccess").click();
});

function headers() {
  const key = accessKey.value.trim() || sessionStorage.getItem("ff_access_key") || "";
  return key ? { "x-app-key": key } : {};
}

async function api(path) {
  const res = await fetch(path, { headers: headers(), cache: "no-store" });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || data.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

function drawCards() {
  apiCards.innerHTML = providers.map((p) => `
    <div class="card" id="card-${p.id}">
      <div class="card-head"><b>${p.name}</b><span class="status">대기</span></div>
      <div class="detail">${p.detail}<br>연결 점검 전입니다.</div>
    </div>
  `).join("");
}

drawCards();

function setCard(id, state, text) {
  const card = $(`card-${id}`);
  if (!card) return;
  const status = card.querySelector(".status");
  const detail = card.querySelector(".detail");
  const labels = { ok: "정상", bad: "오류", wait: "점검중", idle: "대기" };
  status.textContent = labels[state] || state;
  status.className = `status ${state === "idle" ? "" : state}`.trim();
  detail.textContent = text;
}

function showDeployNotice(html) {
  deployNotice.innerHTML = html;
  deployNotice.classList.remove("hidden");
}

function hideDeployNotice() {
  deployNotice.innerHTML = "";
  deployNotice.classList.add("hidden");
}

$("testAll").addEventListener("click", async () => {
  hideDeployNotice();
  providers.forEach((p) => setCard(p.id, "wait", "현재 배포본의 바인딩을 확인하는 중..."));

  let config;
  try {
    config = await api("/api/config-status");
  } catch (e) {
    providers.forEach((p) => setCard(p.id, "bad", e.message));
    if (e.status === 401) {
      showDeployNotice("<b>개인 접속키가 맞지 않습니다.</b><br>Cloudflare의 APP_ACCESS_KEY와 같은 값을 입력하고 ‘적용’을 누른 뒤 다시 점검하세요.");
    } else {
      showDeployNotice(`<b>현재 Worker의 설정 상태를 읽지 못했습니다.</b><br>${escapeHtml(e.message)}`);
    }
    return;
  }

  if (Array.isArray(config.missing) && config.missing.length) {
    const missing = config.missing.map((x) => `<code>${escapeHtml(x)}</code>`).join(", ");
    const detected = (config.runtimeBindingsDetected || []).length
      ? config.runtimeBindingsDetected.map((x) => `<code>${escapeHtml(x)}</code>`).join(", ")
      : "없음";
    showDeployNotice(
      `<b>Cloudflare 화면에는 값이 있어도 현재 실행 중인 Worker 버전에는 아직 반영되지 않았습니다.</b><br>` +
      `누락: ${missing}<br>현재 Worker가 감지한 값: ${detected}<br><br>` +
      `<b>해결:</b> Settings → Variables and Secrets → 각 값 확인 → <b>Deploy</b>를 누르세요. ` +
      `APP_ACCESS_KEY와 KIS_APP_KEY도 Secret 타입으로 바꾸는 것을 권장합니다.`
    );
  }

  for (const p of providers) {
    if (!config.configured?.[p.id]) {
      const required = {
        dart: "DART_API_KEY",
        kis: "KIS_APP_KEY, KIS_APP_SECRET",
        krx: "KRX_AUTH_KEY",
        ecos: "ECOS_API_KEY",
      }[p.id];
      setCard(p.id, "bad", `현재 배포본에서 미감지: ${required}`);
      continue;
    }

    setCard(p.id, "wait", "실제 API 응답을 확인하는 중...");
    try {
      const data = await api(p.endpoint);
      if (p.id === "dart") setCard(p.id, "ok", `${data.sample?.corpName || "기업조회 성공"} · 인증 정상`);
      if (p.id === "kis") setCard(p.id, "ok", `${fmt(data.sample?.price)}원 · 시세조회 정상`);
      if (p.id === "krx") setCard(p.id, "ok", `${formatDate(data.date)} · ${fmt(data.rows)}개 행 수신`);
      if (p.id === "ecos") setCard(p.id, "ok", `${fmt(data.rows)}개 주요지표 수신 · 인증 정상`);
    } catch (e) {
      setCard(p.id, "bad", e.message);
    }
  }
});

$("analyze").addEventListener("click", async () => {
  const code = $("stockCode").value.trim();
  const corp = $("corpCode").value.trim();
  if (!/^\d{6}$/.test(code)) return alert("종목코드는 6자리 숫자입니다.");
  if (corp && !/^\d{8}$/.test(corp)) return alert("DART 기업고유번호는 8자리 숫자입니다.");

  loading.classList.remove("hidden");
  result.classList.add("hidden");
  try {
    const q = new URLSearchParams({ code });
    if (corp) q.set("corp", corp);
    const data = await api(`/api/analyze?${q}`);
    lastAnalysis = data;
    renderResult(data);
  } catch (e) {
    result.innerHTML = `
      <div class="note error-note">
        <b>분석 실패</b><br>${escapeHtml(e.message)}
        <br><br><span class="muted">먼저 위의 ‘전체 연결 점검’에서 KIS가 정상인지 확인해주세요.</span>
      </div>`;
    result.classList.remove("hidden");
  } finally {
    loading.classList.add("hidden");
  }
});

function renderResult(d) {
  const t = d.technical || {};
  const s = d.supply || {};
  const f = d.finance || {};
  const snap = d.snapshot || {};
  const latestRatio = f.latestRatio || {};
  const latestAnnual = f.annual?.[0] || {};
  const supplyClass = (s.score || 0) >= 80 ? "good" : (s.score || 0) >= 50 ? "warn" : "bad";
  const techClass = t.wavePass ? "good" : "warn";
  const debtClass = Number.isFinite(Number(latestRatio.debtRatio))
    ? Number(latestRatio.debtRatio) < 150 ? "good" : "bad"
    : "neutral";
  const zoneText = zoneLabel(t.zone);
  const opMargin = margin(latestAnnual.operatingIncome, latestAnnual.revenue);
  const dartName = d.dart?.company?.corpName || null;
  const sourceErrors = Array.isArray(d.sourceErrors) ? d.sourceErrors : [];

  result.innerHTML = `
    <div class="result-title">
      <div>
        <h3>${escapeHtml(snap.name || d.code)}</h3>
        <div class="sub">${escapeHtml(snap.industry || "업종정보 없음")} · ${escapeHtml(d.code)}${dartName ? ` · ${escapeHtml(dartName)}` : ""}</div>
      </div>
      <div class="sub">분석시각 ${formatDateTime(d.analyzedAt)}</div>
    </div>

    ${sourceErrors.length ? `
      <div class="note warning-note"><b>일부 데이터만 표시 중</b><br>${sourceErrors.map((x) => `${escapeHtml(x.label)}: ${escapeHtml(x.error)}`).join("<br>")}</div>
    ` : ""}

    <div class="result-grid">
      <div class="metric">
        <h3>시장 스냅샷</h3>
        <div class="big">${fmt(snap.price)}원</div>
        <div class="kv">
          <span>PER</span><span>${fmt2(snap.per)}</span>
          <span>PBR</span><span>${fmt2(snap.pbr)}</span>
          <span>시가총액</span><span>${snap.marketCap100MKRW == null ? "-" : `${fmt(snap.marketCap100MKRW)}억원`}</span>
          <span>외국인 보유수량</span><span>${fmt(snap.foreignHoldingQty)}</span>
        </div>
      </div>

      <div class="metric">
        <h3>기술 · 타이밍</h3>
        <div class="big ${techClass}">${t.wavePass ? "정배열 상승" : "미충족"}</div>
        <div class="kv">
          <span>MA20</span><span>${fmt(t.ma20)}</span>
          <span>MA60</span><span>${fmt(t.ma60)}</span>
          <span>MA120</span><span>${fmt(t.ma120)}</span>
          <span>현재 위치</span><span>${zoneText}</span>
        </div>
      </div>

      <div class="metric">
        <h3>수급 · 지속매집</h3>
        <div class="big ${supplyClass}">${s.score ?? 0}/100</div>
        <div class="kv">
          <span>판정</span><span>${escapeHtml(s.label || "-")}</span>
          <span>외국인 20일</span><span class="${signClass(s.foreign?.net20d)}">${signed(s.foreign?.net20d)}</span>
          <span>기관 20일</span><span class="${signClass(s.institution?.net20d)}">${signed(s.institution?.net20d)}</span>
          <span>동반 순매수일</span><span>${fmt(s.joint?.bothPositiveDays20)}일</span>
        </div>
      </div>

      <div class="metric">
        <h3>최근 연간 실적</h3>
        <div class="big">${periodLabel(latestAnnual.period)}</div>
        <div class="kv">
          <span>매출액</span><span>${fmtFinancial(latestAnnual.revenue)}</span>
          <span>영업이익</span><span>${fmtFinancial(latestAnnual.operatingIncome)}</span>
          <span>영업이익률</span><span>${fmtPct(opMargin)}</span>
          <span>당기순이익</span><span>${fmtFinancial(latestAnnual.netIncome)}</span>
        </div>
      </div>

      <div class="metric">
        <h3>안정성</h3>
        <div class="big ${debtClass}">${fmtPct(latestRatio.debtRatio)}</div>
        <div class="kv">
          <span>부채비율</span><span>${fmtPct(latestRatio.debtRatio)}</span>
          <span>FF 기준</span><span>${Number.isFinite(Number(latestRatio.debtRatio)) ? (Number(latestRatio.debtRatio) < 150 ? "150% 미만 통과" : "150% 이상 주의") : "확인 필요"}</span>
          <span>유보율</span><span>${fmtPct(latestRatio.reserveRatio)}</span>
          <span>ROE</span><span>${fmtPct(latestRatio.roe)}</span>
        </div>
      </div>

      <div class="metric">
        <h3>외국인 보유 확대</h3>
        <div class="big ${signClass(s.foreign?.exhaustionRateDelta30d)}">${signedPct(s.foreign?.exhaustionRateDelta30d)}</div>
        <div class="kv">
          <span>현재 보유비율</span><span>${fmtPct(s.foreign?.exhaustionRateNow)}</span>
          <span>약 30일 전</span><span>${fmtPct(s.foreign?.exhaustionRate30dAgo)}</span>
          <span>20일 순매수일</span><span>${fmt(s.foreign?.positiveDays20)}일</span>
          <span>현재 연속 순매수</span><span>${fmt(s.foreign?.currentPositiveStreak)}일</span>
        </div>
      </div>
    </div>

    <div class="note">
      아래 상세항목은 기본적으로 닫혀 있습니다. 필요한 항목만 눌러 펼쳐보세요. 재무 금액은 KIS 손익계산서 API가 반환한 원자료 수치를 그대로 표시하며, 분기 손익은 누적값을 개별 분기로 환산했습니다.
    </div>

    <div class="accordions">
      ${priceAccordion(t)}
      ${supplyAccordion(s)}
      ${annualAccordion(f.annual || [])}
      ${quarterAccordion(f.quarterly || [], f.note)}
      ${ratioAccordion(f.ratios || [], latestRatio)}
      ${dartAccordion(d.dart)}
    </div>
  `;

  result.classList.remove("hidden");
  bindAccordions(d);
}

function priceAccordion(t) {
  return `
    <details class="accordion" id="acc-price">
      <summary><span>주가 차트 · MA20 / MA60 / MA120</span><span class="accordion-meta">최근 ${fmt(t.series?.length || 0)}거래일</span></summary>
      <div class="accordion-body">
        <div class="chart-box"><canvas id="priceChart" class="chart"></canvas></div>
        <div class="legend">
          <span class="legend-close"><i></i>종가</span>
          <span class="legend-ma20"><i></i>MA20</span>
          <span class="legend-ma60"><i></i>MA60</span>
          <span class="legend-ma120"><i></i>MA120</span>
        </div>
        <div class="note"><b>FF 정배열 기준:</b> 현재가 &gt; MA20 &gt; MA60 &gt; MA120이며 MA60·MA120의 기울기도 상승하는지를 함께 봅니다.</div>
      </div>
    </details>`;
}

function supplyAccordion(s) {
  const rows = [...(s.daily || [])].reverse();
  return `
    <details class="accordion" id="acc-supply">
      <summary><span>외국인 · 기관 수급 상세</span><span class="accordion-meta">지속매집 점수 ${s.score ?? 0}/100</span></summary>
      <div class="accordion-body">
        <div class="ratio-grid compact-ratios">
          ${miniRatio("외국인 5일", signed(s.foreign?.net5d), signClass(s.foreign?.net5d))}
          ${miniRatio("외국인 20일", signed(s.foreign?.net20d), signClass(s.foreign?.net20d))}
          ${miniRatio("외국인 30일", signed(s.foreign?.net30d), signClass(s.foreign?.net30d))}
          ${miniRatio("기관 5일", signed(s.institution?.net5d), signClass(s.institution?.net5d))}
          ${miniRatio("기관 20일", signed(s.institution?.net20d), signClass(s.institution?.net20d))}
          ${miniRatio("기관 30일", signed(s.institution?.net30d), signClass(s.institution?.net30d))}
        </div>
        <div class="chart-box chart-gap"><canvas id="supplyChart" class="chart"></canvas></div>
        <div class="legend">
          <span class="legend-foreign"><i></i>외국인 순매수</span>
          <span class="legend-inst"><i></i>기관 순매수</span>
        </div>
        <div class="table-wrap table-gap">
          <table>
            <thead><tr><th>거래일</th><th>외국인 순매수</th><th>기관 순매수</th><th>동반 매수</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr>
                <td>${formatDate(r.date)}</td>
                <td class="${signClass(r.foreign)}">${signed(r.foreign)}</td>
                <td class="${signClass(r.institution)}">${signed(r.institution)}</td>
                <td>${r.foreign > 0 && r.institution > 0 ? "●" : "-"}</td>
              </tr>`).join("") || emptyRow(4)}
            </tbody>
          </table>
        </div>
        <div class="note">기관은 이 API에서 실제 보유주식수 시계열을 직접 제공하지 않아 <b>누적 순매수와 순매수 지속성</b>을 보유 확대의 대용지표로 사용합니다. 외국인은 보유비율 변화도 별도로 가점합니다.</div>
      </div>
    </details>`;
}

function annualAccordion(rows) {
  return `
    <details class="accordion" id="acc-annual">
      <summary><span>최근 3년 매출액 · 영업이익</span><span class="accordion-meta">성장성 확인</span></summary>
      <div class="accordion-body">
        <div class="table-wrap">
          <table>
            <thead><tr><th>결산</th><th>매출액</th><th>영업이익</th><th>영업이익률</th><th>당기순이익</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr>
                <td>${periodLabel(r.period)}</td>
                <td>${fmtFinancial(r.revenue)}</td>
                <td class="${signClass(r.operatingIncome)}">${fmtFinancial(r.operatingIncome)}</td>
                <td>${fmtPct(margin(r.operatingIncome, r.revenue))}</td>
                <td class="${signClass(r.netIncome)}">${fmtFinancial(r.netIncome)}</td>
              </tr>`).join("") || emptyRow(5)}
            </tbody>
          </table>
        </div>
        <div class="note">FF 성장성 기준에서는 단순 매출 증가보다 <b>영업이익이 여러 해에 걸쳐 증가하는지</b>를 더 중요하게 볼 예정입니다. 다음 스크리너 단계에서 자동 점수화합니다.</div>
      </div>
    </details>`;
}

function quarterAccordion(rows, note) {
  return `
    <details class="accordion" id="acc-quarter">
      <summary><span>최근 4개 분기 매출액 · 영업이익</span><span class="accordion-meta">실적 방향 전환 확인</span></summary>
      <div class="accordion-body">
        <div class="table-wrap">
          <table>
            <thead><tr><th>분기</th><th>매출액</th><th>영업이익</th><th>영업이익률</th><th>당기순이익</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr>
                <td>${escapeHtml(r.label || periodLabel(r.period))}</td>
                <td>${fmtFinancial(r.revenue)}</td>
                <td class="${signClass(r.operatingIncome)}">${fmtFinancial(r.operatingIncome)}</td>
                <td>${fmtPct(margin(r.operatingIncome, r.revenue))}</td>
                <td class="${signClass(r.netIncome)}">${fmtFinancial(r.netIncome)}</td>
              </tr>`).join("") || emptyRow(5)}
            </tbody>
          </table>
        </div>
        <div class="note">${escapeHtml(note || "분기 실적을 표시합니다.")}</div>
      </div>
    </details>`;
}

function ratioAccordion(rows, latest) {
  const debtOk = Number.isFinite(Number(latest?.debtRatio)) && Number(latest.debtRatio) < 150;
  return `
    <details class="accordion" id="acc-ratio">
      <summary><span>안정성 · 유보율 · 부채비율</span><span class="accordion-meta">FF 재무 필터</span></summary>
      <div class="accordion-body">
        <div class="ratio-grid">
          <div class="ratio-card">
            <div class="label">부채비율</div>
            <div class="value ${latest?.debtRatio == null ? "neutral" : debtOk ? "good" : "bad"}">${fmtPct(latest?.debtRatio)}</div>
            <div class="hint">현재 FF 기준: 150% 미만을 우선적으로 안정 구간으로 평가</div>
          </div>
          <div class="ratio-card">
            <div class="label">유보율</div>
            <div class="value">${fmtPct(latest?.reserveRatio)}</div>
            <div class="hint">납입자본금 대비 내부에 축적된 잉여금 수준을 보는 보조지표</div>
          </div>
          <div class="ratio-card">
            <div class="label">ROE</div>
            <div class="value">${fmtPct(latest?.roe)}</div>
            <div class="hint">자기자본 대비 이익창출력을 확인하는 수익성 보조지표</div>
          </div>
        </div>
        <div class="table-wrap table-gap">
          <table>
            <thead><tr><th>결산</th><th>부채비율</th><th>유보율</th><th>ROE</th><th>매출 증가율</th><th>영업이익 증가율</th></tr></thead>
            <tbody>${rows.map((r) => `
              <tr>
                <td>${periodLabel(r.period)}</td>
                <td class="${Number.isFinite(Number(r.debtRatio)) ? (Number(r.debtRatio) < 150 ? "pos" : "neg") : "neutral"}">${fmtPct(r.debtRatio)}</td>
                <td>${fmtPct(r.reserveRatio)}</td>
                <td>${fmtPct(r.roe)}</td>
                <td class="${signClass(r.revenueGrowth)}">${signedPctPlain(r.revenueGrowth)}</td>
                <td class="${signClass(r.operatingIncomeGrowth)}">${signedPctPlain(r.operatingIncomeGrowth)}</td>
              </tr>`).join("") || emptyRow(6)}
            </tbody>
          </table>
        </div>
      </div>
    </details>`;
}

function dartAccordion(dart) {
  if (!dart) return "";
  const c = dart.company || {};
  return `
    <details class="accordion" id="acc-dart">
      <summary><span>DART 기업정보</span><span class="accordion-meta">사업보고서 연결 기초</span></summary>
      <div class="accordion-body">
        ${dart.ok ? `
          <div class="kv wide-kv">
            <span>법인명</span><span>${escapeHtml(c.corpName || "-")}</span>
            <span>종목코드</span><span>${escapeHtml(c.stockCode || "-")}</span>
            <span>대표자</span><span>${escapeHtml(c.ceo || "-")}</span>
            <span>업종코드</span><span>${escapeHtml(c.industryCode || "-")}</span>
            <span>결산월</span><span>${escapeHtml(c.fiscalMonth || "-")}</span>
          </div>` : `<div class="note warning-note">${escapeHtml(dart.error || dart.message || "DART 조회 실패")}</div>`}
      </div>
    </details>`;
}

function bindAccordions(d) {
  const price = $("acc-price");
  const supply = $("acc-supply");

  price?.addEventListener("toggle", () => {
    if (price.open) requestAnimationFrame(() => drawPriceChart($("priceChart"), d.technical?.series || []));
  });
  supply?.addEventListener("toggle", () => {
    if (supply.open) requestAnimationFrame(() => drawSupplyChart($("supplyChart"), d.supply?.daily || []));
  });
}

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!lastAnalysis) return;
    if ($("acc-price")?.open) drawPriceChart($("priceChart"), lastAnalysis.technical?.series || []);
    if ($("acc-supply")?.open) drawSupplyChart($("supplyChart"), lastAnalysis.supply?.daily || []);
  }, 160);
});

function drawPriceChart(canvas, rows) {
  if (!canvas || !rows.length) return drawEmptyChart(canvas, "주가 데이터가 없습니다.");
  const series = [
    { key: "close", label: "종가", color: "#172b4d", width: 2.2 },
    { key: "ma20", label: "MA20", color: "#2e7d32", width: 1.6 },
    { key: "ma60", label: "MA60", color: "#d97706", width: 1.6 },
    { key: "ma120", label: "MA120", color: "#7c3aed", width: 1.6 },
  ];
  drawLineChart(canvas, rows, series, {
    xKey: "date",
    valueFormatter: shortNumber,
    zeroLine: false,
  });
}

function drawSupplyChart(canvas, rows) {
  if (!canvas || !rows.length) return drawEmptyChart(canvas, "수급 데이터가 없습니다.");
  const series = [
    { key: "foreign", label: "외국인", color: "#1d4ed8", width: 1.8 },
    { key: "institution", label: "기관", color: "#b45309", width: 1.8 },
  ];
  drawLineChart(canvas, rows, series, {
    xKey: "date",
    valueFormatter: shortSigned,
    zeroLine: true,
  });
}

function drawLineChart(canvas, rows, series, options = {}) {
  const box = canvas.parentElement;
  const cssWidth = Math.max(320, box.clientWidth - 20);
  const cssHeight = Math.max(250, Number.parseInt(getComputedStyle(canvas).height, 10) || 300);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const pad = { left: 66, right: 18, top: 18, bottom: 36 };
  const w = cssWidth - pad.left - pad.right;
  const h = cssHeight - pad.top - pad.bottom;
  const allValues = [];
  for (const row of rows) {
    for (const s of series) {
      const value = Number(row[s.key]);
      if (Number.isFinite(value)) allValues.push(value);
    }
  }
  if (!allValues.length) return drawEmptyChart(canvas, "표시 가능한 값이 없습니다.");

  let min = Math.min(...allValues);
  let max = Math.max(...allValues);
  if (options.zeroLine) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    min -= Math.abs(min || 1) * 0.05;
    max += Math.abs(max || 1) * 0.05;
  }
  const extra = (max - min) * 0.06;
  min -= extra;
  max += extra;

  ctx.font = "11px Arial, sans-serif";
  ctx.textBaseline = "middle";
  ctx.strokeStyle = "#dfe5ee";
  ctx.fillStyle = "#667085";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (h * i / 4);
    const value = max - ((max - min) * i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();
    ctx.textAlign = "right";
    ctx.fillText((options.valueFormatter || shortNumber)(value), pad.left - 8, y);
  }

  if (options.zeroLine && min < 0 && max > 0) {
    const zy = pad.top + h * ((max - 0) / (max - min));
    ctx.save();
    ctx.strokeStyle = "#98a2b3";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, zy);
    ctx.lineTo(pad.left + w, zy);
    ctx.stroke();
    ctx.restore();
  }

  const xAt = (idx) => pad.left + (rows.length === 1 ? w / 2 : w * idx / (rows.length - 1));
  const yAt = (value) => pad.top + h * ((max - value) / (max - min));

  for (const s of series) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.7;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    let started = false;
    ctx.beginPath();
    rows.forEach((row, idx) => {
      const v = Number(row[s.key]);
      if (!Number.isFinite(v)) {
        started = false;
        return;
      }
      const x = xAt(idx);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
    ctx.restore();
  }

  const labelIndexes = uniqueSorted([0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1]);
  ctx.fillStyle = "#667085";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const idx of labelIndexes) {
    const label = formatDateShort(rows[idx]?.[options.xKey || "date"]);
    ctx.fillText(label, xAt(idx), pad.top + h + 10);
  }
}

function drawEmptyChart(canvas, message) {
  if (!canvas) return;
  const box = canvas.parentElement;
  const width = Math.max(320, box?.clientWidth - 20 || 640);
  const height = 280;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#667085";
  ctx.font = "14px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(message, width / 2, height / 2);
}

function miniRatio(label, value, cls = "") {
  return `<div class="ratio-card"><div class="label">${escapeHtml(label)}</div><div class="value ${cls}">${escapeHtml(String(value))}</div></div>`;
}

function emptyRow(cols) {
  return `<tr><td colspan="${cols}" class="neutral empty-cell">표시할 데이터가 없습니다.</td></tr>`;
}

function zoneLabel(zone) {
  return {
    between_ma60_ma120: "60~120일선 사이",
    below_ma120: "120일선 아래",
    above_ma20: "20일선 위",
    between_ma20_ma60_or_below_ma20: "20~60일선 구간",
  }[zone] || "확인 필요";
}

function periodLabel(period) {
  const s = String(period || "");
  if (!/^\d{6}$/.test(s)) return s || "-";
  return `${s.slice(0, 4)}.${s.slice(4, 6)}`;
}

function formatDate(value) {
  const s = String(value || "").replace(/[^0-9]/g, "");
  if (s.length !== 8) return value || "-";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function formatDateShort(value) {
  const s = String(value || "").replace(/[^0-9]/g, "");
  if (s.length !== 8) return value || "";
  return `${Number(s.slice(4, 6))}/${Number(s.slice(6, 8))}`;
}

function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

function fmt(v) {
  return isFiniteValue(v) ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 0 }) : "-";
}

function fmt2(v) {
  return isFiniteValue(v) ? Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "-";
}

function fmtPct(v) {
  return isFiniteValue(v) ? `${Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%` : "-";
}

function signed(v) {
  if (!isFiniteValue(v)) return "-";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}`;
}

function signedPct(v) {
  if (!isFiniteValue(v)) return "-";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%p`;
}

function signedPctPlain(v) {
  if (!isFiniteValue(v)) return "-";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}%`;
}

function fmtFinancial(v) {
  if (!isFiniteValue(v)) return "-";
  return Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

function margin(op, rev) {
  if (!isFiniteValue(op) || !isFiniteValue(rev) || Number(rev) === 0) return null;
  return Number(op) / Number(rev) * 100;
}

function signClass(v) {
  if (!isFiniteValue(v) || Number(v) === 0) return "neutral";
  return Number(v) > 0 ? "pos" : "neg";
}

function isFiniteValue(v) {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

function shortNumber(v) {
  if (!Number.isFinite(Number(v))) return "-";
  const n = Number(v);
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(a >= 1e10 ? 0 : 1)}억`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(a >= 1e6 ? 0 : 1)}만`;
  return Math.round(n).toLocaleString("ko-KR");
}

function shortSigned(v) {
  if (!Number.isFinite(Number(v))) return "-";
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  const a = Math.abs(n);
  if (a >= 1e8) return `${sign}${(n / 1e8).toFixed(1)}억`;
  if (a >= 1e4) return `${sign}${(n / 1e4).toFixed(1)}만`;
  return `${sign}${Math.round(n).toLocaleString("ko-KR")}`;
}

function uniqueSorted(values) {
  return [...new Set(values.filter((v) => Number.isInteger(v) && v >= 0))].sort((a, b) => a - b);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>'"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[c]));
}

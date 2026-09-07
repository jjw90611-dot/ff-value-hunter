const $ = (id) => document.getElementById(id);
const accessKey = $("accessKey");
const accessMsg = $("accessMsg");
const apiCards = $("apiCards");
const result = $("result");
const loading = $("loading");

const providers = [
  { id: "dart", name: "OpenDART", endpoint: "/api/test/dart", detail: "공시·기업·재무" },
  { id: "kis", name: "한국투자 KIS", endpoint: "/api/test/kis", detail: "주가·수급·차트" },
  { id: "krx", name: "KRX", endpoint: "/api/test/krx", detail: "공식 시장 데이터" },
  { id: "ecos", name: "한국은행 ECOS", endpoint: "/api/test/ecos", detail: "금리·환율·거시" },
];

accessKey.value = sessionStorage.getItem("ff_access_key") || "";

$("saveAccess").addEventListener("click", () => {
  sessionStorage.setItem("ff_access_key", accessKey.value.trim());
  accessMsg.textContent = accessKey.value.trim() ? "접속키를 현재 브라우저 세션에 적용했습니다." : "접속키를 비웠습니다.";
});

function headers() {
  const key = accessKey.value.trim() || sessionStorage.getItem("ff_access_key") || "";
  return key ? { "x-app-key": key } : {};
}

async function api(path) {
  const res = await fetch(path, { headers: headers() });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || data.ok === false) throw new Error(data.error || data.message || `HTTP ${res.status}`);
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

$("testAll").addEventListener("click", async () => {
  for (const p of providers) {
    const card = $(`card-${p.id}`);
    const status = card.querySelector(".status");
    const detail = card.querySelector(".detail");
    status.textContent = "점검중";
    status.className = "status wait";
    detail.textContent = "API 응답을 기다리는 중...";
    try {
      const data = await api(p.endpoint);
      status.textContent = "정상";
      status.className = "status ok";
      if (p.id === "dart") detail.textContent = `${data.sample?.corpName || "기업조회 성공"} · 인증 정상`;
      if (p.id === "kis") detail.textContent = `${data.sample?.price?.toLocaleString?.() || data.sample?.price || "시세조회 성공"}원 · 인증 정상`;
      if (p.id === "krx") detail.textContent = `${data.date} · ${data.rows}개 행 수신`;
      if (p.id === "ecos") detail.textContent = `${data.rows}개 주요지표 수신 · 인증 정상`;
    } catch (e) {
      status.textContent = "오류";
      status.className = "status bad";
      detail.textContent = e.message;
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
    renderResult(data);
  } catch (e) {
    result.innerHTML = `<div class="note" style="background:#fff0ee;color:#8f1d14"><b>분석 실패</b><br>${escapeHtml(e.message)}</div>`;
    result.classList.remove("hidden");
  } finally {
    loading.classList.add("hidden");
  }
});

function renderResult(d) {
  const t = d.technical || {};
  const s = d.supply || {};
  const snap = d.snapshot || {};
  const supplyClass = s.score >= 80 ? "good" : s.score >= 50 ? "warn" : "bad";
  const techClass = t.wavePass ? "good" : "warn";
  const zoneText = {
    between_ma60_ma120: "60~120일선 사이",
    below_ma120: "120일선 아래",
    above_ma20: "20일선 위",
    between_ma20_ma60_or_below_ma20: "20~60일선 구간",
  }[t.zone] || "확인 필요";

  const dartCompany = d.dart?.company?.corpName ? d.dart.company.corpName : "DART 미연결";
  const fin = d.dart?.financials || {};

  result.innerHTML = `
    <div class="result-title">
      <div><h3>${escapeHtml(snap.name || d.code)}</h3><div class="sub">${escapeHtml(snap.industry || "업종정보 없음")} · ${d.code}</div></div>
      <div class="sub">${escapeHtml(dartCompany)}</div>
    </div>
    <div class="result-grid">
      <div class="metric">
        <h3>시장 스냅샷</h3>
        <div class="big">${fmt(snap.price)}원</div>
        <div class="kv">
          <span>PER</span><span>${fmt2(snap.per)}</span>
          <span>PBR</span><span>${fmt2(snap.pbr)}</span>
          <span>외국인 보유수량</span><span>${fmt(snap.foreignHoldingQty)}</span>
          <span>외국인 소진율</span><span>${fmt2(snap.foreignExhaustionRate)}%</span>
        </div>
      </div>

      <div class="metric">
        <h3>기술 · 산업파도 기초</h3>
        <div class="big ${techClass}">${t.wavePass ? "정배열 상승" : "미충족"}</div>
        <div class="kv">
          <span>MA20</span><span>${fmt(t.ma20)}</span>
          <span>MA60</span><span>${fmt(t.ma60)}</span>
          <span>MA120</span><span>${fmt(t.ma120)}</span>
          <span>현재 위치</span><span>${zoneText}</span>
        </div>
      </div>

      <div class="metric">
        <h3>수급 점수</h3>
        <div class="big ${supplyClass}">${s.score ?? 0}/100</div>
        <div class="kv">
          <span>외국인 20일</span><span>${signed(s.foreign?.net20d)}</span>
          <span>기관 20일</span><span>${signed(s.institution?.net20d)}</span>
          <span>동반 순매수일</span><span>${fmt(s.joint?.bothPositiveDays20)}일</span>
          <span>외국인 보유비율 변화</span><span>${signedPct(s.foreign?.exhaustionRateDelta30d)}</span>
        </div>
      </div>

      <div class="metric">
        <h3>외국인 지속 매집</h3>
        <div class="kv">
          <span>5일 누적</span><span>${signed(s.foreign?.net5d)}</span>
          <span>20일 누적</span><span>${signed(s.foreign?.net20d)}</span>
          <span>30일 누적</span><span>${signed(s.foreign?.net30d)}</span>
          <span>20일 중 순매수</span><span>${fmt(s.foreign?.positiveDays20)}일</span>
          <span>현재 연속 순매수</span><span>${fmt(s.foreign?.currentPositiveStreak)}일</span>
        </div>
      </div>

      <div class="metric">
        <h3>기관 지속 매집</h3>
        <div class="kv">
          <span>5일 누적</span><span>${signed(s.institution?.net5d)}</span>
          <span>20일 누적</span><span>${signed(s.institution?.net20d)}</span>
          <span>30일 누적</span><span>${signed(s.institution?.net30d)}</span>
          <span>20일 중 순매수</span><span>${fmt(s.institution?.positiveDays20)}일</span>
          <span>현재 연속 순매수</span><span>${fmt(s.institution?.currentPositiveStreak)}일</span>
        </div>
      </div>

      <div class="metric">
        <h3>DART 재무 스냅샷</h3>
        <div class="kv">
          <span>매출</span><span>${money(fin.revenue?.amount)}</span>
          <span>영업이익</span><span>${money(fin.operatingIncome?.amount)}</span>
          <span>당기순이익</span><span>${money(fin.netIncome?.amount)}</span>
          <span>자산총계</span><span>${money(fin.assets?.amount)}</span>
          <span>부채총계</span><span>${money(fin.liabilities?.amount)}</span>
        </div>
      </div>
    </div>
    <div class="note">
      <b>v0.1 판독법</b><br>
      현재 버전은 API 연결과 단일종목 수급·기술 로직을 검증하는 단계입니다. 특히 외국인/기관은 하루 매수보다 5·20·30일 누적, 순매수 지속일수, 외국인 보유비율 상승에 가점을 줍니다. 기관의 직접 보유량 시계열은 현재 KIS 엔드포인트에서 바로 제공되지 않아 누적 순매수를 대용지표로 사용합니다. 전체 KOSPI/KOSDAQ 자동 스크리닝과 업종지수 파도는 다음 버전에서 D1 캐시와 함께 추가합니다.
    </div>
  `;
  result.classList.remove("hidden");
}

function fmt(v) { return v === null || v === undefined || Number.isNaN(Number(v)) ? "-" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 0 }); }
function fmt2(v) { return v === null || v === undefined || Number.isNaN(Number(v)) ? "-" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: 2 }); }
function signed(v) { if (v === null || v === undefined || Number.isNaN(Number(v))) return "-"; const n = Number(v); return `${n > 0 ? "+" : ""}${n.toLocaleString("ko-KR")}`; }
function signedPct(v) { if (v === null || v === undefined || Number.isNaN(Number(v))) return "-"; const n = Number(v); return `${n > 0 ? "+" : ""}${n.toFixed(2)}%p`; }
function money(v) { if (v === null || v === undefined || Number.isNaN(Number(v))) return "-"; const n = Number(v); if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(2)}조`; if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(0)}억`; return n.toLocaleString("ko-KR"); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" }[c])); }

const $ = (id) => document.getElementById(id);
const accessKey = $("accessKey");
const accessMsg = $("accessMsg");
const apiCards = $("apiCards");
const deployNotice = $("deployNotice");
const result = $("result");
const loading = $("loading");
const stockCodeInput = $("stockCode");
const corpCodeInput = $("corpCode");
const stockSearchInput = $("stockSearch");
const stockSuggestions = $("stockSuggestions");
const selectedStockBar = $("selectedStockBar");
const selectedStockLogo = $("selectedStockLogo");
const selectedStockName = $("selectedStockName");
const selectedStockEnglish = $("selectedStockEnglish");
const selectedStockCodeView = $("selectedStockCode");
const selectedStockMarket = $("selectedStockMarket");

const providers = [
  { id: "dart", name: "OpenDART", endpoint: "/api/test/dart", detail: "공시·기업정보 (선택 기능)" },
  { id: "kis", name: "한국투자 KIS", endpoint: "/api/test/kis", detail: "핵심: 주가·수급·차트·재무·기업정보" },
  { id: "krx", name: "KRX", endpoint: "/api/test/krx", detail: "전체시장·종목 기본정보·일별매매·지수 검증" },
  { id: "ecos", name: "한국은행 ECOS", endpoint: "/api/test/ecos", detail: "금리·환율·거시" },
];

let lastAnalysis = null;
let resizeTimer = null;
let analyzeProgressTimer = null;
const stockSearchState = { items: [], activeIndex: -1, timer: null, lastQuery: "" };

accessKey.value = sessionStorage.getItem("ff_access_key") || "";

$("saveAccess").addEventListener("click", () => {
  const value = accessKey.value.trim();
  if (value) sessionStorage.setItem("ff_access_key", value);
  else sessionStorage.removeItem("ff_access_key");
  accessMsg.textContent = value
    ? "접속키를 현재 브라우저 세션에 적용했습니다. 산업 목록을 불러옵니다."
    : "접속키를 비웠습니다.";
  if (value && sectorState.sectors.length === 0) setTimeout(() => loadSectorList(), 120);
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

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json; charset=utf-8" },
    cache: "no-store",
    body: JSON.stringify(payload || {}),
  });
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

// -----------------------------
// v1.0 산업 → 저평가 우량주 → Evidence Gate → 기업 검증 흐름
// -----------------------------
const sectorGrid = $("sectorGrid");
const sectorEmpty = $("sectorEmpty");
const sectorProgress = $("sectorProgress");
const sectorDetail = $("sectorDetail");
const memberGrid = $("memberGrid");
const rankProgress = $("rankProgress");
const looperaSection = $("step3");
const runLooperaAdviceButton = $("runLooperaAdvice");
const looperaReady = $("looperaReady");
const looperaProgress = $("looperaProgress");
const looperaOverview = $("looperaOverview");
const looperaAdviceGrid = $("looperaAdviceGrid");
const researchMemoryPanel = $("researchMemoryPanel");
const researchMemoryList = $("researchMemoryList");
const RESEARCH_MEMORY_KEY = "ff_loopera_research_memory_v1";
const looperaState = { items: new Map(), running: false, lastSectorId: null };

const sectorState = {
  sectors: [],
  trends: new Map(),
  filter: "rising",
  selected: null,
  members: [],
  rankings: new Map(),
  scanning: false,
};

$("loadSectors")?.addEventListener("click", loadSectorList);
$("scanSectors")?.addEventListener("click", scanAllSectorTrends);
$("rankMembers")?.addEventListener("click", rankSelectedSectorMembers);
$("sectorSearch")?.addEventListener("input", renderSectorCards);
$("memberSearch")?.addEventListener("input", renderMembers);
runLooperaAdviceButton?.addEventListener("click", runLooperaAdviceScan);
$("clearResearchMemory")?.addEventListener("click", () => {
  localStorage.removeItem(RESEARCH_MEMORY_KEY);
  renderResearchMemory();
});
looperaAdviceGrid?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-loopera-select]");
  if (!button) return;
  const code = String(button.dataset.looperaSelect || "");
  const member = sectorState.members.find((item) => item.code === code) || { code, name: button.dataset.stockName || code, market: button.dataset.stockMarket || "" };
  setSelectedStock(member);
  document.querySelector("#step4")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
renderResearchMemory();

$("sectorFilters")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-filter]");
  if (!btn) return;
  sectorState.filter = btn.dataset.filter;
  $("sectorFilters").querySelectorAll(".chip").forEach((el) => el.classList.toggle("active", el === btn));
  renderSectorCards();
});

sectorGrid?.addEventListener("click", (event) => {
  const card = event.target.closest("[data-sector-id]");
  if (!card) return;
  const sector = sectorState.sectors.find((x) => x.id === card.dataset.sectorId);
  if (sector) openSector(sector);
});

memberGrid?.addEventListener("click", (event) => {
  const detailButton = event.target.closest("[data-stock-detail]");
  if (!detailButton) return;
  const code = detailButton.dataset.stockDetail;
  if (!/^\d{6}$/.test(code || "")) return;
  const stock = sectorState.members.find((item) => item.code === code) || {
    code,
    name: detailButton.dataset.stockName || code,
    market: detailButton.dataset.stockMarket || "",
    englishName: detailButton.dataset.stockEnglish || "",
  };
  setSelectedStock(stock);
  document.querySelector(".stock-detail-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => $("analyze")?.click(), 280);
});

$("sectorChartAcc")?.addEventListener("toggle", () => {
  if (!$("sectorChartAcc").open) return;
  const trend = sectorState.selected ? sectorState.trends.get(sectorState.selected.id) : null;
  requestAnimationFrame(() => drawSectorChart($("sectorChart"), trend?.series || []));
});

initializeStockSearch();
updateNpayTopLink("");

function initializeStockSearch() {
  if (!stockSearchInput || !stockSuggestions) return;

  stockSearchInput.addEventListener("input", () => {
    const current = (stockSearchInput.value || "").trim();
    if (stockCodeInput.value && current !== (selectedStockName?.textContent || "").trim()) clearSelectedStockSelection();
    scheduleStockSearch(current);
  });
  stockSearchInput.addEventListener("focus", () => {
    if ((stockSearchInput.value || "").trim()) scheduleStockSearch(stockSearchInput.value);
  });
  stockSearchInput.addEventListener("keydown", handleStockSearchKeydown);

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".stock-search-wrap")) hideStockSuggestions();
  });

  document.addEventListener("keydown", (event) => {
    const hotkey = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
    if (!hotkey) return;
    event.preventDefault();
    stockSearchInput.focus();
    stockSearchInput.select();
  });
}

function clearSelectedStockSelection() {
  stockCodeInput.value = "";
  selectedStockBar?.classList.add("hidden");
  $("analyze").disabled = true;
  updateNpayTopLink("");
}

function setSelectedStock(item = {}) {
  const code = String(item.code || "").trim();
  if (!/^\d{6}$/.test(code)) return;
  const name = String(item.name || code).trim() || code;
  const englishName = String(item.englishName || item.nameEn || "").trim();
  const market = String(item.market || "").trim();

  stockCodeInput.value = code;
  stockSearchInput.value = name;
  selectedStockBar?.classList.remove("hidden");
  if (selectedStockName) selectedStockName.textContent = name;
  if (selectedStockEnglish) {
    selectedStockEnglish.textContent = englishName;
    selectedStockEnglish.classList.toggle("hidden", !englishName);
  }
  if (selectedStockCodeView) selectedStockCodeView.textContent = code;
  if (selectedStockMarket) selectedStockMarket.textContent = market || "국내주식";
  if (selectedStockLogo) selectedStockLogo.textContent = stockInitials(name);
  $("analyze").disabled = false;
  updateNpayTopLink(code);
  hideStockSuggestions();
}

function stockInitials(name) {
  const text = String(name || "ST").trim();
  const latin = text.match(/[A-Za-z]/g);
  if (latin?.length >= 2) return `${latin[0]}${latin[1]}`.toUpperCase();
  return text.replace(/[^가-힣A-Za-z0-9]/g, "").slice(0, 2) || "ST";
}

function scheduleStockSearch(query) {
  const q = String(query || "").trim();
  clearTimeout(stockSearchState.timer);
  if (!q) {
    stockSearchState.items = [];
    stockSearchState.activeIndex = -1;
    hideStockSuggestions();
    return;
  }
  stockSearchState.timer = setTimeout(() => performStockSearch(q), 180);
}

async function performStockSearch(query) {
  const q = String(query || "").trim();
  if (!q) return hideStockSuggestions();
  stockSearchState.lastQuery = q;
  stockSuggestions.classList.remove("hidden");
  stockSuggestions.innerHTML = `<div class="suggestion-state">기업을 찾는 중입니다…</div>`;

  try {
    const data = await api(`/api/search-stocks?q=${encodeURIComponent(q)}&limit=12`);
    if (stockSearchState.lastQuery !== q) return;
    stockSearchState.items = Array.isArray(data.items) ? data.items : [];
    stockSearchState.activeIndex = stockSearchState.items.length ? 0 : -1;
    renderStockSearchSuggestions();
  } catch (error) {
    if (stockSearchState.lastQuery !== q) return;
    stockSearchState.items = [];
    stockSearchState.activeIndex = -1;
    stockSuggestions.classList.remove("hidden");
    stockSuggestions.innerHTML = `<div class="suggestion-state">검색 중 오류가 발생했습니다.<br>${escapeHtml(error.message)}</div>`;
  }
}

function renderStockSearchSuggestions() {
  if (!stockSuggestions) return;
  const items = stockSearchState.items || [];
  if (!items.length) {
    stockSuggestions.classList.remove("hidden");
    stockSuggestions.innerHTML = `<div class="suggestion-state">검색 결과가 없습니다.<br>회사명 또는 6자리 종목코드로 다시 검색해보세요.</div>`;
    return;
  }

  stockSuggestions.classList.remove("hidden");
  stockSuggestions.innerHTML = items.map((item, index) => {
    const english = item.englishName || item.nameEn || "";
    const subtitle = english || `${item.market || "국내주식"} · ${item.code}`;
    return `
      <button type="button" class="stock-suggestion ${index === stockSearchState.activeIndex ? "active" : ""}" data-stock-suggestion="${escapeHtml(item.code)}" role="option" aria-selected="${index === stockSearchState.activeIndex ? "true" : "false"}">
        <span class="stock-suggestion-logo">${escapeHtml(stockInitials(item.name))}</span>
        <span class="stock-suggestion-name"><b>${escapeHtml(item.name || item.code)}</b><span>${escapeHtml(subtitle)}</span></span>
        <span class="stock-suggestion-meta"><b>${escapeHtml(item.code)}</b><span>${escapeHtml(item.market || "KR")}</span></span>
      </button>`;
  }).join("");

  stockSuggestions.querySelectorAll("[data-stock-suggestion]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = items.find((x) => x.code === button.dataset.stockSuggestion);
      if (item) setSelectedStock(item);
    });
  });
}

function handleStockSearchKeydown(event) {
  const items = stockSearchState.items || [];
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!items.length) return;
    stockSearchState.activeIndex = (stockSearchState.activeIndex + 1 + items.length) % items.length;
    renderStockSearchSuggestions();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!items.length) return;
    stockSearchState.activeIndex = (stockSearchState.activeIndex - 1 + items.length) % items.length;
    renderStockSearchSuggestions();
  } else if (event.key === "Enter") {
    if (items[stockSearchState.activeIndex]) {
      event.preventDefault();
      setSelectedStock(items[stockSearchState.activeIndex]);
    } else {
      const raw = (stockSearchInput.value || "").trim();
      if (/^\d{6}$/.test(raw)) {
        event.preventDefault();
        setSelectedStock({ code: raw, name: raw, market: "" });
      }
    }
  } else if (event.key === "Escape") {
    hideStockSuggestions();
  }
}

function hideStockSuggestions() {
  stockSuggestions?.classList.add("hidden");
}

async function loadSectorList() {
  updateSectorStats("불러오는 중");
  setSectorProgress("KOSPI·KOSDAQ 업종을 불러오는 중입니다…", true);
  $("loadSectors").disabled = true;
  try {
    const data = await api("/api/sectors");
    sectorState.sectors = (data.sectors || []).map((item) => ({ ...item }));
    sectorState.trends.clear();
    sectorState.selected = null;
    sectorState.members = [];
    sectorState.rankings.clear();
    resetLooperaSection();
    sectorDetail.classList.add("hidden");
    $("scanSectors").disabled = sectorState.sectors.length === 0;
    sectorEmpty.classList.toggle("hidden", sectorState.sectors.length > 0);
    sectorGrid.classList.toggle("hidden", sectorState.sectors.length === 0);
    renderSectorCards();
    const errorText = data.errors?.length ? ` · 일부 업종 조회 오류 ${data.errors.length}건` : "";
    setSectorProgress(`${fmt(sectorState.sectors.length)}개 업종을 불러왔습니다${errorText}. ‘상승 흐름 분석’을 누르면 장기 추세 순위가 완성됩니다.`, true);
    updateSectorStats("섹터 준비");
  } catch (error) {
    sectorEmpty.classList.remove("hidden");
    sectorGrid.classList.add("hidden");
    sectorEmpty.innerHTML = `<b>섹터를 불러오지 못했습니다.</b><span>${escapeHtml(error.message)}<br>KIS 연결상태와 개인 접속키를 확인해주세요.</span>`;
    setSectorProgress("", false);
    updateSectorStats("연결 확인");
  } finally {
    $("loadSectors").disabled = false;
  }
}

async function scanAllSectorTrends() {
  if (sectorState.scanning || !sectorState.sectors.length) return;
  updateSectorStats("분석 중");
  sectorState.scanning = true;
  $("scanSectors").disabled = true;
  $("loadSectors").disabled = true;

  // 장기 추세는 당일 등락률과 무관하므로 모든 업종을 순차 검사합니다.
  const sectors = [...sectorState.sectors];
  let success = 0;
  let failed = 0;
  for (let i = 0; i < sectors.length; i++) {
    const sector = sectors[i];
    setSectorProgress(`산업 파도 분석 · ${sector.name}`, true, Math.round(((i + 1) / sectors.length) * 100), `${i + 1}/${sectors.length} 섹터`);
    try {
      const q = new URLSearchParams({ market: sector.marketCode, code: sector.code });
      const data = await api(`/api/sector-trend?${q}`);
      sectorState.trends.set(sector.id, data.trend || null);
      success += 1;
    } catch (error) {
      sectorState.trends.set(sector.id, { ok: false, score: 0, label: "조회 실패", error: error.message });
      failed += 1;
    }
    if ((i + 1) % 3 === 0 || i === sectors.length - 1) renderSectorCards();
    // 캐시 응답이어도 안정적으로 호출 간격을 둡니다.
    await sleep(560);
  }

  sectorState.scanning = false;
  $("scanSectors").disabled = false;
  $("loadSectors").disabled = false;
  const strong = sectors.filter((s) => (sectorState.trends.get(s.id)?.score || 0) >= 74).length;
  setSectorProgress(`분석 완료 · ${success}개 성공${failed ? ` · ${failed}개 오류` : ""} · A등급(74점) 이상 ${strong}개`, true, 100, "완료");
  renderSectorCards();
  updateSectorStats("분석 완료");
}


function updateSectorStats(statusLabel = null) {
  const total = sectorState.sectors.length;
  const trends = [...sectorState.trends.values()].filter(Boolean);
  const rising = trends.filter((t) => t?.ok && Number(t.score) >= 74).length;
  const aligned = trends.filter((t) => t?.ok && t.wavePass === true).length;
  if ($("sectorTotalStat")) $("sectorTotalStat").textContent = total ? fmt(total) : "-";
  if ($("sectorRisingStat")) $("sectorRisingStat").textContent = trends.length ? fmt(rising) : "-";
  if ($("sectorAlignedStat")) $("sectorAlignedStat").textContent = trends.length ? fmt(aligned) : "-";
  if ($("sectorStatusStat") && statusLabel) $("sectorStatusStat").textContent = statusLabel;
}

function renderSectorCards() {
  if (!sectorGrid) return;
  const keyword = ($("sectorSearch")?.value || "").trim().toLowerCase();
  const scannedAny = sectorState.trends.size > 0;
  let items = sectorState.sectors.filter((s) => !keyword || `${s.name} ${s.market}`.toLowerCase().includes(keyword));

  if (sectorState.filter === "aligned") {
    items = items.filter((s) => sectorState.trends.get(s.id)?.wavePass === true);
  } else if (sectorState.filter === "rising" && scannedAny) {
    items = items.filter((s) => {
      const t = sectorState.trends.get(s.id);
      return !t || (t.ok && (t.score >= 58 || t.return60d > 0));
    });
  }

  items.sort((a, b) => {
    const ta = sectorState.trends.get(a.id);
    const tb = sectorState.trends.get(b.id);
    const scoreDiff = (tb?.score ?? -1) - (ta?.score ?? -1);
    if (scoreDiff) return scoreDiff;
    return (b.dayPct || 0) - (a.dayPct || 0);
  });

  sectorGrid.innerHTML = items.map((s) => sectorCardHtml(s, sectorState.trends.get(s.id))).join("") || `
    <div class="empty-state"><div class="empty-icon">⌕</div><b>조건에 맞는 섹터가 없습니다.</b><span>필터를 ‘전체 섹터’로 바꾸거나 검색어를 지워보세요.</span></div>`;
  updateSectorStats(sectorState.scanning ? "분석 중" : (sectorState.trends.size ? "분석 완료" : (sectorState.sectors.length ? "섹터 준비" : "대기")));
}

function sectorCardHtml(sector, trend) {
  const score = trend?.ok ? Number(trend.score) : null;
  const scoreClass = score >= 90 ? "strong" : score >= 74 ? "good" : score >= 58 ? "watch" : "neutral-card";
  const dayClass = signClass(sector.dayPct);
  const trendLabel = trend?.label || "장기추세 미분석";
  const wave = trend?.wavePass ? "정배열 ✓" : trend?.ok ? "정배열 미충족" : "분석 전";
  const grade = trend?.grade || "-";
  return `
    <button class="sector-card ${scoreClass}" data-sector-id="${escapeHtml(sector.id)}">
      <div class="sector-card-top">
        <span class="market-tag ${sector.market === "KOSDAQ" ? "q" : "k"}">${escapeHtml(sector.market)}</span>
        <span class="day-change ${dayClass}">${signedPctPlain(sector.dayPct)}</span>
      </div>
      <h3>${escapeHtml(sector.name)}</h3>
      <div class="sector-member-count">관련기업 ${fmt(sector.memberCount || 0)}개</div>
      <div class="sector-score-row"><b>${score === null ? "--" : score.toFixed(1)}</b><span>/100</span><em>${escapeHtml(grade)}</em></div>
      <div class="sector-label">${escapeHtml(trendLabel)}</div>
      <div class="sector-mini">
        <span>${wave}</span>
        <span>20일 ${trend?.return20d == null ? "-" : signedPctPlain(trend.return20d)}</span>
        <span>60일 ${trend?.return60d == null ? "-" : signedPctPlain(trend.return60d)}</span>
        ${trend?.positiveDays60Pct == null ? "" : `<span>60일 상승일 ${fmt1(trend.positiveDays60Pct)}%</span>`}
      </div>
    </button>`;
}

async function openSector(sector) {
  sectorState.selected = sector;
  sectorState.members = [];
  sectorState.rankings.clear();
  resetLooperaSection();
  if ($("memberSearch")) $("memberSearch").value = ""; // 이전 섹터 검색어가 남아 새 섹터 종목을 숨기는 문제 방지
  sectorDetail.classList.remove("hidden");
  $("sectorTitle").textContent = `${sector.name} · ${sector.market}`;
  $("sectorSubtitle").textContent = "관련기업과 재무 우량순위를 불러오는 중입니다.";
  $("memberCount").textContent = "관련기업 불러오는 중…";
  memberGrid.innerHTML = `<div class="empty-state"><div class="empty-icon">⌁</div><b>관련기업을 불러오는 중입니다.</b><span>잠시만 기다려주세요.</span></div>`;
  sectorDetail.scrollIntoView({ behavior: "smooth", block: "start" });

  let trend = sectorState.trends.get(sector.id);
  if (!trend || !trend.ok) {
    try {
      const q = new URLSearchParams({ market: sector.marketCode, code: sector.code });
      const data = await api(`/api/sector-trend?${q}`);
      trend = data.trend;
      sectorState.trends.set(sector.id, trend);
      renderSectorCards();
    } catch (error) {
      trend = { ok: false, score: 0, label: "추세 조회 실패", error: error.message };
    }
  }
  renderSectorTrendSummary(sector, trend);

  try {
    const q = new URLSearchParams({ code: sector.code, name: sector.name, market: sector.marketCode });
    const data = await api(`/api/sector-members?${q}`);
    sectorState.members = data.members || [];
    const count = Number(data.total || sectorState.members.length || 0);
    const krxText = data.krx?.available ? ` · KRX ${formatDate(data.krx.date)} 시장데이터 반영` : "";
    $("sectorSubtitle").textContent = `${count}개 관련기업 · KIS 산업분류 정확매핑${krxText}`;
    $("memberCount").textContent = `관련기업 ${fmt(count)}개`;
    renderMembers();
    if (!count) {
      memberGrid.innerHTML = `<div class="empty-state"><div class="empty-icon">↻</div><b>이 섹터는 자동으로 목록에서 제외될 예정입니다.</b><span>새로고침 후 ‘섹터 불러오기’를 다시 누르면 기업이 매핑되지 않는 특수지수는 표시되지 않습니다.</span></div>`;
    }
  } catch (error) {
    memberGrid.innerHTML = `<div class="empty-state"><div class="empty-icon">!</div><b>관련기업 조회에 실패했습니다.</b><span>${escapeHtml(error.message)}</span></div>`;
    $("sectorSubtitle").textContent = "관련기업 조회에 실패했습니다.";
  }
}

function renderSectorTrendSummary(sector, trend) {
  const box = $("sectorTrendSummary");
  if (!box) return;
  if (!trend?.ok) {
    box.innerHTML = `<div class="note warning-note">장기 추세 데이터를 충분히 불러오지 못했습니다. ${escapeHtml(trend?.error || "")}</div>`;
    return;
  }
  const bd = trend.scoreBreakdown || {};
  box.innerHTML = `
    <div class="trend-metric"><span>지속상승 점수</span><b class="${trend.score >= 74 ? "good" : trend.score >= 58 ? "warn" : "neutral"}">${fmt1(trend.score)}/100</b><small>${escapeHtml(trend.grade || "-")} · ${escapeHtml(trend.label)}</small></div>
    <div class="trend-metric"><span>정배열</span><b class="${trend.wavePass ? "good" : "warn"}">${trend.wavePass ? "통과" : "관찰"}</b><small>현재가 &gt; MA20 &gt; MA60 &gt; MA120</small></div>
    <div class="trend-metric"><span>20일</span><b class="${signClass(trend.return20d)}">${signedPctPlain(trend.return20d)}</b><small>단기 산업 파도</small></div>
    <div class="trend-metric"><span>60일</span><b class="${signClass(trend.return60d)}">${signedPctPlain(trend.return60d)}</b><small>중기 산업 파도</small></div>
    <div class="trend-metric"><span>120일</span><b class="${signClass(trend.return120d)}">${signedPctPlain(trend.return120d)}</b><small>장기 변화</small></div>
    <div class="trend-breakdown">
      <span>정배열·이격 <b>${fmt1(bd.structure)}/25</b></span>
      <span>이평선 기울기 <b>${fmt1(bd.slope)}/25</b></span>
      <span>20·60·120일 모멘텀 <b>${fmt1(bd.momentum)}/30</b></span>
      <span>상승 지속성 <b>${fmt1(bd.persistence)}/10</b></span>
      <span>낙폭·위치 <b>${fmt1(bd.riskQuality)}/10</b></span>
    </div>`;
  if ($("sectorChartAcc")?.open) requestAnimationFrame(() => drawSectorChart($("sectorChart"), trend.series || []));
}

function renderMembers() {
  if (!memberGrid) return;
  const keyword = ($("memberSearch")?.value || "").trim().toLowerCase();
  const rows = sectorState.members
    .filter((m) => !keyword || `${m.name} ${m.code} ${m.englishName || ""}`.toLowerCase().includes(keyword))
    .map((m) => ({ ...m, rank: sectorState.rankings.get(m.code) || null }))
    .sort((a, b) => {
      const ar = a.rank;
      const br = b.rank;
      if (ar && br) {
        const as = Number(ar.finalScore ?? ar.score ?? -1);
        const bs = Number(br.finalScore ?? br.score ?? -1);
        if (bs !== as) return bs - as;
        const av = Number(ar.valueScore ?? -1);
        const bv = Number(br.valueScore ?? -1);
        if (bv !== av) return bv - av;
        const aq = Number(ar.qualityScore ?? ar.score ?? -1);
        const bq = Number(br.qualityScore ?? br.score ?? -1);
        if (bq !== aq) return bq - aq;
      }
      if (br && !ar) return 1;
      if (ar && !br) return -1;
      const capB = Number(b.krx?.marketCapWon) || (Number(b.marketCap) || 0) * 100000000;
      const capA = Number(a.krx?.marketCapWon) || (Number(a.marketCap) || 0) * 100000000;
      return capB - capA;
    });

  memberGrid.innerHTML = rows.map((m, index) => memberCardHtml(m, index + 1)).join("") || `
    <div class="empty-state"><div class="empty-icon">⌕</div><b>표시할 기업이 없습니다.</b><span>검색어를 지우거나 다른 섹터를 선택해보세요.</span></div>`;
}

function memberCardHtml(m, displayRank) {
  const r = m.rank;
  const annual = r?.annual || [];
  const latest = annual[0] || {};
  const score = Number(r?.finalScore ?? r?.score);
  const grade = r?.finalGrade || r?.grade || "-";
  const gradeClass = grade === "S" || String(grade).startsWith("A") ? "good" : grade === "B" ? "warn" : "neutral";
  const revenueText = !r ? "분석 전" : r.revenueGrowing3y ? `3년 연속 상승 · CAGR ${fmt1(r.revenueCagr)}%` : annual.length >= 2 ? `${r.revenueTransitions || 0}/2 구간 상승 · CAGR ${fmt1(r.revenueCagr)}%` : "자료 부족";
  const krxCapWon = Number(m.krx?.marketCapWon);
  const cap = Number.isFinite(krxCapWon) && krxCapWon > 0 ? `${fmt(Math.round(krxCapWon / 100000000))}억` : (isFiniteValue(m.marketCap) ? `${fmt(m.marketCap)}억` : "-");
  const qualityHit = r && Number(r.qualityScore ?? r.score) >= 65 && Number(r.debtRatio) < 150;
  const englishName = m.krx?.englishName || m.englishName || "";
  const english = englishName ? `<span>${escapeHtml(englishName)}</span>` : "";
  const krxMove = Number(m.krx?.dayPct);
  const krxChip = Number.isFinite(krxMove) ? `<span class="krx-move ${signClass(krxMove)}">KRX ${signedPctPlain(krxMove)}</span>` : "";
  const v = r?.valuation || {};
  const discount = r?.fairValue?.discountPct;
  const fairText = Number.isFinite(Number(discount)) ? `${Number(discount) >= 0 ? "+" : ""}${fmt1(discount)}%` : "-";
  const position52 = Number.isFinite(Number(v.position52)) ? `${fmt1(v.position52)}%` : "-";
  const trap = Array.isArray(r?.valueTrapWarnings) && r.valueTrapWarnings.length ? `<div class="value-warning">⚠ ${escapeHtml(r.valueTrapWarnings.slice(0, 2).join(" · "))}</div>` : "";
  const target = r?.analystTarget;
  const targetText = target?.targetPrice ? `<span class="analyst-chip">목표가 ${fmt(target.targetPrice)}원 · ${signedPctPlain(target.upsidePct)}</span>` : "";
  return `
    <article class="company-card ${qualityHit ? "quality-hit" : ""}">
      <div class="company-card-top">
        <span class="rank-no">${displayRank}</span>
        <div class="company-name"><b>${escapeHtml(m.name)}</b>${english}<small>${escapeHtml(m.code)} · ${escapeHtml(m.market)} · 시총 ${cap} ${krxChip}</small></div>
        <div class="grade-box">${r ? `<span class="grade-badge ${gradeClass}">${escapeHtml(grade)}</span><span class="grade-score">${Number.isFinite(score) ? fmt1(score) : "-"}</span>` : `<span class="analysis-wait">분석 전</span>`}</div>
      </div>
      <div class="company-metrics value-metrics">
        <div class="company-metric highlight"><small>FF 저평가 우량</small><b>${r?.finalScore != null ? `${fmt1(r.finalScore)}점` : "분석 필요"}</b></div>
        <div class="company-metric"><small>Quality</small><b>${r ? `${fmt1(r.qualityScore ?? r.score)}/100` : "-"}</b></div>
        <div class="company-metric"><small>Value</small><b class="${Number(r?.valueScore) >= 70 ? "pos" : ""}">${r?.valueScore != null ? `${fmt1(r.valueScore)}/100` : "-"}</b></div>
        <div class="company-metric"><small>참고 적정가 할인</small><b class="${Number(discount) > 0 ? "pos" : Number.isFinite(Number(discount)) ? "neg" : "neutral"}">${fairText}</b></div>
        <div class="company-metric"><small>52주 저가→고가 위치</small><b class="${Number(v.position52) <= 35 ? "pos" : Number(v.position52) >= 75 ? "neg" : ""}">${position52}</b></div>
        <div class="company-metric"><small>PER / PBR</small><b>${fmt2(v.per)} / ${fmt2(v.pbr)}</b></div>
        <div class="company-metric"><small>ROE / 부채</small><b>${fmtPct(r?.roe)} / ${fmtPct(r?.debtRatio)}</b></div>
        <div class="company-metric"><small>3년 매출</small><b class="${r?.revenueGrowing3y ? "pos" : "neutral"}">${escapeHtml(revenueText)}</b></div>
        <div class="company-metric"><small>최근 4분기 검증</small><b class="${r?.quarterlyMetrics?.testPass === true ? "pos" : r?.quarterlyMetrics?.testPass === false ? "neg" : "neutral"}">${r?.quarterlyMetrics?.testPass === true ? "통과" : r?.quarterlyMetrics?.testPass === false ? "미통과" : "자료부족"} · ${r?.quarterlyMetrics?.score != null ? fmt1(r.quarterlyMetrics.score)+"/50" : "-"}</b></div>
        <div class="company-metric"><small>TTM 매출 / 영업익</small><b>${r?.quarterlyMetrics?.ttmRevenueGrowth == null ? "-" : signedPctPlain(r.quarterlyMetrics.ttmRevenueGrowth)} / ${r?.quarterlyMetrics?.ttmOperatingGrowth == null ? "-" : signedPctPlain(r.quarterlyMetrics.ttmOperatingGrowth)}</b></div>
        <div class="company-metric"><small>외국인·기관 매집</small><b class="${Number(r?.accumulationScore) >= 68 ? "pos" : Number.isFinite(Number(r?.accumulationScore)) ? "neutral" : ""}">${r?.accumulationScore != null ? `${fmt1(r.accumulationScore)}/100` : "2단계 검증 대기"}</b></div>
        <div class="company-metric"><small>1년 주가 vs 실적</small><b class="${Number(r?.price1yChangePct) < 0 && Number(r?.fundamentalPriceDivergenceBonus) > 0 ? "pos" : ""}">${r?.price1yChangePct == null ? "-" : signedPctPlain(r.price1yChangePct)}${Number(r?.fundamentalPriceDivergenceBonus) > 0 ? ` · 괴리 +${fmt1(r.fundamentalPriceDivergenceBonus)}` : ""}</b></div>
        <div class="company-metric risk-metric"><small>공시·뉴스 위험</small><b class="${Number(r?.riskPenalty) > 0 ? "neg" : Number.isFinite(Number(r?.riskPenalty)) ? "pos" : "neutral"}">${r?.riskPenalty == null ? "상위후보 검증" : `-${fmt1(r.riskPenalty)}점`}</b></div>
      </div>
      ${r?.accumulation?.signals?.length ? `<div class="signal-row">${r.accumulation.signals.slice(0,3).map(x=>`<span>${escapeHtml(x)}</span>`).join("")}</div>` : ""}
      ${r?.risk?.disclosure?.items?.length ? `<div class="value-warning">⚠ 최근 공시: ${escapeHtml(r.risk.disclosure.items.slice(0,2).map(x=>x.title).join(" · "))}</div>` : ""}
      ${targetText ? `<div class="analyst-row">${targetText}</div>` : ""}
      ${trap}
      <div class="company-actions">
        <a class="mini-link npay" href="${npayUrl(m.code)}" target="_blank" rel="noopener noreferrer">Npay 차트 ↗</a>
        <button class="mini-button" data-stock-detail="${escapeHtml(m.code)}" data-stock-name="${escapeHtml(m.name)}" data-stock-market="${escapeHtml(m.market)}" data-stock-english="${escapeHtml(englishName)}">FF 상세분석</button>
      </div>
    </article>`;
}

async function rankSelectedSectorMembers() {
  if (!sectorState.selected || !sectorState.members.length) return;
  const btn = $("rankMembers");
  btn.disabled = true;
  sectorState.rankings.clear();
  renderMembers();

  const candidates = selectDiverseCandidates(sectorState.members, 60);
  let completed = 0;
  let errors = 0;
  setRankProgress(`1단계 · 분기/연간 실적과 Value 원자료를 수집합니다.`, true, 1, `0/${candidates.length}`);

  for (let i = 0; i < candidates.length; i += 6) {
    const batch = candidates.slice(i, i + 6);
    try {
      const q = new URLSearchParams({ codes: batch.map((x) => x.code).join(",") });
      const data = await api(`/api/rank-stocks?${q}`);
      for (const item of data.items || []) sectorState.rankings.set(item.code, item);
      completed += batch.length;
    } catch (error) {
      errors += batch.length;
    }
    const done = Math.min(i + batch.length, candidates.length);
    const pct = Math.round((done / Math.max(1, candidates.length)) * 62);
    setRankProgress(`1단계 · 분기 매출·영업이익률 · 연간 성장 · PER/PBR/ROE · 52주 위치`, true, pct, `${done}/${candidates.length} 기업`);
    renderMembers();
    await sleep(520);
  }

  const analyzed = [...sectorState.rankings.values()];
  const scored = applySectorValueScores(analyzed);
  for (const item of scored) sectorState.rankings.set(item.code, item);
  renderMembers();

  // 2단계: 상위 후보에만 수급·거래량·1년 가격괴리·DART/뉴스 리스크를 붙입니다.
  const deepCandidates = [...scored]
    .filter((x) => Number.isFinite(Number(x.finalScore)))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, Math.min(16, scored.length));

  for (let i = 0; i < deepCandidates.length; i++) {
    const item = deepCandidates[i];
    const member = sectorState.members.find((m) => m.code === item.code);
    const name = member?.name || item.code;
    const pct = 62 + Math.round(((i + 1) / Math.max(1, deepCandidates.length)) * 27);
    setRankProgress(`2단계 · 외국인/기관 지속매집 · 거래량 패턴 · 공시/뉴스 위험 검증`, true, pct, `${i + 1}/${deepCandidates.length} · ${name}`);
    try {
      const q = new URLSearchParams({ code: item.code, name });
      const data = await api(`/api/deep-signals?${q}`);
      const acc = Number(data.accumulation?.score || 0);
      const riskPenalty = Number(data.risk?.penalty || 0);
      const qtm = item.quarterlyMetrics || {};
      const price1y = Number(data.technical?.price1yChangePct);
      const divergenceBonus = fundamentalPriceDivergenceBonus(qtm, price1y);
      const adjustedValue = Math.max(0, Math.min(100, Number(item.valueScore || 0) + divergenceBonus));
      const deepBase = Number(item.qualityScore || 0) * 0.40 + adjustedValue * 0.40 + acc * 0.20;
      item.valueScore = roundClient(adjustedValue, 1);
      item.accumulationScore = roundClient(acc, 1);
      item.accumulation = data.accumulation || null;
      item.supply = data.supply || null;
      item.price1yChangePct = Number.isFinite(price1y) ? roundClient(price1y, 1) : null;
      item.fundamentalPriceDivergenceBonus = divergenceBonus;
      item.risk = data.risk || null;
      item.riskPenalty = riskPenalty;
      item.baseFinalScore = roundClient(Math.max(0, Math.min(100, deepBase - riskPenalty)), 1);
      item.finalScore = item.baseFinalScore;
      item.finalGrade = gradeFromScoreClient(item.finalScore);
      item.grade = item.finalGrade;
      item.score = item.finalScore;
      sectorState.rankings.set(item.code, item);
    } catch (_) {
      // Deep 검증 실패 시 1단계 점수는 유지합니다.
    }
    renderMembers();
    await sleep(460);
  }

  // 3단계: 증권사 목표가는 상위 후보의 보조자료로만 최대 +2점 적용합니다.
  const topForOpinion = [...sectorState.rankings.values()]
    .filter((x) => Number.isFinite(Number(x.finalScore)))
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, 6);
  for (let i = 0; i < topForOpinion.length; i++) {
    const item = topForOpinion[i];
    const pct = 90 + Math.round(((i + 1) / Math.max(1, topForOpinion.length)) * 9);
    setRankProgress(`3단계 · 증권사 목표가 보조검증`, true, pct, `${i + 1}/${topForOpinion.length}`);
    try {
      const data = await api(`/api/target-opinion?code=${encodeURIComponent(item.code)}`);
      if (data.latest?.targetPrice && Number(item.valuation?.price) > 0) {
        const upsidePct = ((Number(data.latest.targetPrice) - Number(item.valuation.price)) / Number(item.valuation.price)) * 100;
        const bonus = Math.min(2, targetPriceBonus(upsidePct) * 0.5);
        item.analystTarget = { ...data.latest, upsidePct: roundClient(upsidePct, 1), bonus };
        item.finalScore = roundClient(Math.min(100, Number(item.baseFinalScore || item.finalScore) + bonus), 1);
        item.finalGrade = gradeFromScoreClient(item.finalScore);
        sectorState.rankings.set(item.code, item);
      }
    } catch (_) {}
    await sleep(420);
  }

  const finalItems = [...sectorState.rankings.values()];
  const strong = finalItems.filter((r) => Number(r.finalScore) >= 75 && Number(r.qualityScore) >= 65).length;
  const consistent = finalItems.filter((r) => r.quarterlyMetrics?.testPass === true && Number(r.quarterlyMetrics?.ttmRevenueGrowth) > 0 && Number(r.quarterlyMetrics?.ttmOperatingGrowth) > 0).length;
  const accum = finalItems.filter((r) => Number(r.accumulationScore) >= 68).length;
  setRankProgress(`분석 완료 · FF 75점 이상 ${strong}개 · 최근 4분기 검증 통과 ${consistent}개 · 매집 우위 ${accum}개${errors ? ` · 원자료 오류 ${errors}개` : ""}`, true, 100, "완료");
  renderMembers();
  btn.disabled = false;
  prepareLooperaAdvice();
}

// -----------------------------------------------------------------------------
// v1.0 · Loopera's Advice — public methodology inspired, independent implementation
// -----------------------------------------------------------------------------
function resetLooperaSection() {
  looperaState.items.clear();
  looperaState.running = false;
  looperaState.lastSectorId = null;
  looperaSection?.classList.add("hidden");
  looperaProgress?.classList.add("hidden");
  looperaOverview?.classList.add("hidden");
  looperaAdviceGrid?.classList.add("hidden");
  researchMemoryPanel?.classList.add("hidden");
  if (runLooperaAdviceButton) {
    runLooperaAdviceButton.disabled = true;
    runLooperaAdviceButton.textContent = "Evidence Gate 실행";
  }
  if (looperaReady) {
    looperaReady.classList.remove("hidden");
    looperaReady.innerHTML = `<div class="loopera-orbit"><span></span><i></i><b>FF</b></div><div><b>STEP 2 분석을 마치면 상위 후보를 연구계약으로 변환합니다.</b><span>분기 지속성 · 실적-가격 괴리 · 외국인/기관 매집 · DART 공시 · 현금흐름 품질을 서로 독립된 증거로 확인합니다.</span></div>`;
  }
}

function prepareLooperaAdvice() {
  if (!sectorState.selected) return;
  const candidates = looperaCandidates();
  looperaSection?.classList.remove("hidden");
  looperaState.lastSectorId = sectorState.selected.id;
  if (runLooperaAdviceButton) runLooperaAdviceButton.disabled = candidates.length === 0;
  if (looperaReady) {
    looperaReady.classList.remove("hidden");
    looperaReady.innerHTML = candidates.length
      ? `<div class="loopera-orbit"><span></span><i></i><b>${candidates.length}</b></div><div><b>FF 상위 ${candidates.length}개 후보가 Evidence Gate를 기다리고 있습니다.</b><span>STEP 2 점수를 그대로 믿지 않고 가설·반대가설·회계 원문·Train→Test 안정성·독립 증거를 순서대로 확인합니다.</span></div>`
      : `<div class="loopera-orbit"><span></span><i></i><b>?</b></div><div><b>검증 가능한 후보가 충분하지 않습니다.</b><span>STEP 2의 저평가 우량주 분석 결과를 먼저 확인해주세요.</span></div>`;
  }
  renderResearchMemory();
}

function looperaCandidates(limit = 8) {
  return [...sectorState.rankings.values()]
    .filter((item) => /^\d{6}$/.test(String(item.code || "")) && Number.isFinite(Number(item.finalScore)))
    .sort((a, b) => Number(b.finalScore) - Number(a.finalScore))
    .slice(0, limit);
}

function buildLooperaPeerContext(items) {
  const values = (key) => (items || []).map((x) => Number(x?.[key])).filter(Number.isFinite);
  const trend = sectorState.selected ? sectorState.trends.get(sectorState.selected.id) : null;
  return {
    qualityMedian: medianClient(values("qualityScore")),
    valueMedian: medianClient(values("valueScore")),
    accumulationMedian: medianClient(values("accumulationScore")),
    finalMedian: medianClient(values("finalScore")),
    sectorTrendScore: Number.isFinite(Number(trend?.score)) ? Number(trend.score) : null,
    candidateCount: items.length,
  };
}

function compactLooperaCandidate(item) {
  const risk = item?.risk || null;
  return {
    code: item.code,
    qualityScore: item.qualityScore,
    valueScore: item.valueScore,
    finalScore: item.finalScore,
    accumulationScore: item.accumulationScore,
    revenueCagr: item.revenueCagr,
    operatingCagr: item.operatingCagr,
    debtRatio: item.debtRatio,
    reserveRatio: item.reserveRatio,
    roe: item.roe,
    operatingMargin: item.operatingMargin,
    price1yChangePct: item.price1yChangePct,
    riskPenalty: item.riskPenalty,
    risk: risk ? {
      penalty: risk.penalty,
      disclosure: risk.disclosure ? { penalty: risk.disclosure.penalty, items: (risk.disclosure.items || []).slice(0, 8) } : null,
      news: risk.news ? { penalty: risk.news.penalty, headlines: (risk.news.headlines || []).slice(0, 5) } : null,
    } : null,
    annual: (item.annual || []).slice(0, 4),
    quarterly: (item.quarterly || []).slice(0, 12),
    quarterlyMetrics: item.quarterlyMetrics || null,
    valuation: item.valuation || null,
    fairValue: item.fairValue || null,
    valueTrapWarnings: item.valueTrapWarnings || [],
    accumulation: item.accumulation || null,
    supply: item.supply ? {
      score: item.supply.score,
      foreign: item.supply.foreign,
      institution: item.supply.institution,
      joint: item.supply.joint,
    } : null,
  };
}

async function runLooperaAdviceScan() {
  if (looperaState.running || !sectorState.selected) return;
  const candidates = looperaCandidates(8);
  if (!candidates.length) return;

  looperaState.running = true;
  looperaState.items.clear();
  runLooperaAdviceButton.disabled = true;
  runLooperaAdviceButton.textContent = "검증 중…";
  looperaReady?.classList.add("hidden");
  looperaOverview?.classList.add("hidden");
  looperaAdviceGrid?.classList.remove("hidden");
  looperaAdviceGrid.innerHTML = `<div class="loopera-empty">상위 후보를 Evidence Gate로 보내는 중입니다.</div>`;
  const allRanked = [...sectorState.rankings.values()].filter((x) => Number.isFinite(Number(x.finalScore)));
  const peerContext = buildLooperaPeerContext(allRanked);
  const trend = sectorState.trends.get(sectorState.selected.id) || null;
  let failures = 0;

  setLooperaProgress(4, "Context 고정", `${candidates.length}개 후보 · STEP 2 결과를 변경하지 않고 연구 입력으로 동결합니다.`);
  await sleep(180);

  for (let i = 0; i < candidates.length; i++) {
    const item = candidates[i];
    const member = sectorState.members.find((m) => m.code === item.code) || { code: item.code, name: item.code, market: sectorState.selected.market };
    const startPct = 8 + Math.round((i / Math.max(1, candidates.length)) * 84);
    setLooperaProgress(startPct, `${i + 1}/${candidates.length} · ${member.name}`, "Hypothesis → DART Accounting → Robustness → 독립 증거 순으로 반증합니다.");
    try {
      const data = await apiPost("/api/loopera-advice", {
        candidate: compactLooperaCandidate(item),
        member: { code: member.code, name: member.name, englishName: member.englishName || member.nameEn || "", market: member.market || "" },
        sector: { id: sectorState.selected.id, code: sectorState.selected.code, name: sectorState.selected.name, market: sectorState.selected.market, trend },
        peerContext,
      });
      const row = { ...(data.advice || {}), accounting: data.accounting || null, methodology: data.methodology || null, member };
      const previous = priorResearchMemory(row.code, row.sector || sectorState.selected?.name || "");
      if (previous) row.memoryComparison = { priorScore: Number(previous.score || 0), priorDecision: previous.decision || "", priorDate: previous.generatedAt || null, delta: roundClient(Number(row.score || 0) - Number(previous.score || 0), 1) };
      looperaState.items.set(item.code, row);
      saveResearchMemory(row);
    } catch (error) {
      failures += 1;
      looperaState.items.set(item.code, {
        code: item.code,
        name: member.name,
        market: member.market || "",
        score: 0,
        decision: "검증 오류",
        hypothesis: { title: "Evidence Gate 실행 실패", mechanism: error.message },
        gates: [], supportEvidence: [], counterEvidence: [error.message], member,
      });
    }
    renderLooperaAdvice();
    const donePct = 8 + Math.round(((i + 1) / Math.max(1, candidates.length)) * 84);
    setLooperaProgress(donePct, `${member.name} 검증 완료`, `${i + 1}/${candidates.length}${failures ? ` · 오류 ${failures}` : ""}`);
    await sleep(240);
  }

  setLooperaProgress(97, "Research Memory 업데이트", "같은 후보를 다음 검토에서 비교할 수 있도록 브라우저 연구기록을 갱신합니다.");
  renderResearchMemory();
  await sleep(220);
  setLooperaProgress(100, "Evidence Gate 완료", `${looperaState.items.size - failures}개 검증 완료${failures ? ` · ${failures}개 오류` : ""}`);
  renderLooperaAdvice();
  looperaState.running = false;
  runLooperaAdviceButton.disabled = false;
  runLooperaAdviceButton.textContent = "Evidence Gate 다시 실행";
}

function setLooperaProgress(percent, title, detail = "") {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  looperaProgress?.classList.remove("hidden");
  if ($("looperaProgressTitle")) $("looperaProgressTitle").textContent = title || "Evidence Gate";
  if ($("looperaProgressDetail")) $("looperaProgressDetail").textContent = detail || "";
  if ($("looperaProgressPct")) $("looperaProgressPct").textContent = `${Math.round(pct)}%`;
  if ($("looperaEnergyBar")) $("looperaEnergyBar").style.width = `${pct}%`;
}

function renderLooperaAdvice() {
  if (!looperaAdviceGrid || !looperaOverview) return;
  const rows = [...looperaState.items.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  if (!rows.length) {
    looperaAdviceGrid.classList.remove("hidden");
    looperaAdviceGrid.innerHTML = `<div class="loopera-empty">아직 Evidence Gate 결과가 없습니다.</div>`;
    return;
  }
  const priority = rows.filter((x) => x.decision === "우선 검토").length;
  const verify = rows.filter((x) => x.decision === "추가 검증").length;
  const hold = rows.filter((x) => x.decision === "보류" || x.criticalRisk).length;
  const avg = rows.reduce((a, b) => a + Number(b.score || 0), 0) / rows.length;
  looperaOverview.classList.remove("hidden");
  looperaOverview.innerHTML = `
    <div><small>검증 후보</small><b>${rows.length}</b><span>STEP 2 상위 후보</span></div>
    <div><small>우선 검토</small><b>${priority}</b><span>Evidence Gate 82+</span></div>
    <div><small>추가 검증</small><b>${verify}</b><span>Evidence Gate 72+</span></div>
    <div><small>평균 Evidence</small><b>${fmt1(avg)}</b><span>공시·회계 반증 후 점수</span></div>`;
  looperaAdviceGrid.classList.remove("hidden");
  looperaAdviceGrid.innerHTML = rows.map((row, index) => looperaAdviceCardHtml(row, index + 1)).join("");
}

function looperaAdviceCardHtml(row, rank) {
  const decisionClass = row.decision === "우선 검토" ? "priority" : row.decision === "보류" || row.criticalRisk ? "stop" : "";
  const gates = (row.gates || []).map((g) => `<div class="evidence-gate ${escapeHtml(g.status || "watch")}" title="${escapeHtml(g.reason || "")}"><small>${escapeHtml(g.name || g.key || "Gate")}</small><b>${fmt1(g.score)}/100</b></div>`).join("");
  const support = (row.supportEvidence || []).slice(0, 5);
  const counter = (row.counterEvidence || []).slice(0, 5);
  const contract = row.researchContract || {};
  const accounting = row.accountingSummary || {};
  const member = row.member || {};
  const failText = (contract.failureConditions || []).slice(0, 4).join(" · ") || "다음 분기 실적·수급·공시 변화에서 가설 무효화 조건을 다시 확인";
  const competingText = (contract.competingMechanisms || []).slice(0, 3).join(" · ") || "대안 설명 자료 부족";
  const accountingTags = [
    accounting.reportLabel ? `DART ${accounting.reportLabel}` : null,
    Number.isFinite(Number(accounting.cashConversionOperating)) ? `CFO/영업익 ${fmt2(accounting.cashConversionOperating)}x` : null,
    Number.isFinite(Number(accounting.cashConversionNet)) ? `CFO/순익 ${fmt2(accounting.cashConversionNet)}x` : null,
    row.memoryComparison ? `이전검증 ${fmt1(row.memoryComparison.priorScore)} → ${fmt1(row.score)} (${row.memoryComparison.delta > 0 ? "+" : ""}${fmt1(row.memoryComparison.delta)})` : null,
  ].filter(Boolean);
  return `
    <article class="advice-card ${decisionClass}">
      <div class="advice-card-top">
        <span class="advice-rank">${rank}</span>
        <div class="advice-name"><b>${escapeHtml(row.name || member.name || row.code)}</b><small>${escapeHtml(row.code || "")} · ${escapeHtml(row.market || member.market || "국내주식")}</small></div>
        <div class="advice-score"><strong>${fmt1(row.score)}</strong><span class="${decisionClass}">${escapeHtml(row.decision || "관찰")}</span></div>
      </div>
      <div class="hypothesis-box"><small>PRIMARY HYPOTHESIS</small><b>${escapeHtml(row.hypothesis?.title || "가설 미정")}</b><p>${escapeHtml(row.hypothesis?.mechanism || "")}</p></div>
      <div class="evidence-gates">${gates || `<div class="evidence-gate watch"><small>Gate</small><b>자료부족</b></div>`}</div>
      ${accountingTags.length ? `<div class="accounting-line">${accountingTags.map((x) => `<span>${escapeHtml(x)}</span>`).join("")}</div>` : ""}
      <div class="evidence-columns">
        <div class="evidence-list good-evidence"><b>✓ 지지 증거</b><ul>${support.length ? support.map((x) => `<li>${escapeHtml(x)}</li>`).join("") : "<li>충분한 지지 증거 없음</li>"}</ul></div>
        <div class="evidence-list bad-evidence"><b>↯ 반대 증거</b><ul>${counter.length ? counter.map((x) => `<li>${escapeHtml(x)}</li>`).join("") : "<li>중대한 반대 증거 미감지</li>"}</ul></div>
      </div>
      <details class="research-contract"><summary>Research Contract · 반증조건 보기</summary><div class="research-contract-body">
        <div class="contract-row"><span>현상</span><b>${escapeHtml(contract.phenomenon || row.hypothesis?.title || "-")}</b></div>
        <div class="contract-row"><span>대안 설명</span><b>${escapeHtml(competingText)}</b></div>
        <div class="contract-row"><span>무효화 조건</span><b>${escapeHtml(failText)}</b></div>
        <div class="contract-row"><span>성과 한계</span><b>IC·Sharpe·MDD·독립 OOS는 실제 과거 패널 walk-forward 구축 전에는 표시하지 않음</b></div>
      </div></details>
      <div class="advice-actions">
        <button type="button" data-loopera-select="${escapeHtml(row.code)}" data-stock-name="${escapeHtml(row.name || member.name || row.code)}" data-stock-market="${escapeHtml(row.market || member.market || "")}">STEP 4 상세검증</button>
        <a href="${npayUrl(row.code)}" target="_blank" rel="noopener noreferrer">Npay 차트 ↗</a>
      </div>
    </article>`;
}

function loadResearchMemory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RESEARCH_MEMORY_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function priorResearchMemory(code, sector = "") {
  return loadResearchMemory().find((x) => x.code === code && (!sector || x.sector === sector)) || null;
}

function saveResearchMemory(row) {
  if (!row?.code || row.decision === "검증 오류") return;
  const memory = loadResearchMemory();
  const record = {
    code: row.code,
    name: row.name || row.code,
    sector: row.sector || sectorState.selected?.name || "",
    score: Number(row.score || 0),
    decision: row.decision || "관찰",
    hypothesis: row.hypothesis?.title || "",
    generatedAt: new Date().toISOString(),
    evidenceVersion: "v1.0",
  };
  const next = [record, ...memory.filter((x) => !(x.code === record.code && x.sector === record.sector))].slice(0, 30);
  try { localStorage.setItem(RESEARCH_MEMORY_KEY, JSON.stringify(next)); } catch {}
}

function renderResearchMemory() {
  if (!researchMemoryPanel || !researchMemoryList) return;
  const memory = loadResearchMemory();
  researchMemoryPanel.classList.toggle("hidden", memory.length === 0);
  if (!memory.length) { researchMemoryList.innerHTML = ""; return; }
  researchMemoryList.innerHTML = memory.slice(0, 12).map((item) => `
    <div class="memory-item">
      <span class="memory-score">${fmt1(item.score)}</span>
      <div><b>${escapeHtml(item.name || item.code)} · ${escapeHtml(item.hypothesis || "Evidence Gate")}</b><small>${escapeHtml(item.sector || "")} · ${formatDateTime(item.generatedAt)}</small></div>
      <span>${escapeHtml(item.decision || "관찰")}</span>
    </div>`).join("");
}


function fundamentalPriceDivergenceBonus(qtm, price1y) {
  if (!qtm || !Number.isFinite(Number(price1y))) return 0;
  const rev = Number(qtm.ttmRevenueGrowth);
  const op = Number(qtm.ttmOperatingGrowth);
  if (!(rev > 0) || !(op > 0) || Number(price1y) >= 0) return 0;
  const growthStrength = Math.min(1, (Math.max(0, rev) + Math.max(0, op)) / 50);
  const priceGap = Math.min(1, Math.abs(Number(price1y)) / 30);
  const consistency = qtm.testPass === true ? 1 : 0.55;
  return roundClient(10 * growthStrength * priceGap * consistency, 1);
}

function selectDiverseCandidates(members, limit = 72) {
  const rows = [...(members || [])];
  if (rows.length <= limit) return rows;
  rows.sort((a, b) => marketCapWon(b) - marketCapWon(a));
  const thirds = [
    rows.slice(0, Math.ceil(rows.length / 3)),
    rows.slice(Math.ceil(rows.length / 3), Math.ceil(rows.length * 2 / 3)),
    rows.slice(Math.ceil(rows.length * 2 / 3)),
  ];
  const each = Math.floor(limit / 3);
  const selected = [];
  for (const group of thirds) selected.push(...evenSample(group, each));
  const used = new Set(selected.map((x) => x.code));
  for (const item of rows) {
    if (selected.length >= limit) break;
    if (!used.has(item.code)) { selected.push(item); used.add(item.code); }
  }
  return selected;
}

function evenSample(rows, count) {
  if (rows.length <= count) return [...rows];
  if (count <= 1) return [rows[Math.floor(rows.length / 2)]];
  const out = [];
  const used = new Set();
  for (let i = 0; i < count; i++) {
    const idx = Math.round(i * (rows.length - 1) / (count - 1));
    if (!used.has(idx)) { out.push(rows[idx]); used.add(idx); }
  }
  return out;
}

function marketCapWon(item) {
  const krx = Number(item?.krx?.marketCapWon);
  if (Number.isFinite(krx) && krx > 0) return krx;
  const master = Number(item?.marketCap);
  return Number.isFinite(master) ? master * 100000000 : 0;
}

function applySectorValueScores(items) {
  const rows = items.map((x) => ({ ...x, valuation: { ...(x.valuation || {}) } }));
  const pers = rows.map((x) => Number(x.valuation.per)).filter((x) => x > 0 && x < 300);
  const pbrs = rows.map((x) => Number(x.valuation.pbr)).filter((x) => x > 0 && x < 30);
  const pbrRoes = rows.map((x) => Number(x.valuation.pbrToRoe)).filter((x) => x > 0 && x < 10);
  const medianPer = medianClient(pers);
  const medianPbrRoe = medianClient(pbrRoes);

  return rows.map((item) => {
    const q = Number(item.qualityScore ?? item.score ?? 0);
    const v = item.valuation || {};
    const price = Number(v.price);
    const fairModels = [];
    if (Number(v.grahamFair) > 0) fairModels.push({ name: "Graham", price: Number(v.grahamFair) });
    if (Number.isFinite(medianPer) && medianPer > 0 && Number(v.eps) > 0) fairModels.push({ name: "섹터 PER", price: medianPer * Number(v.eps) });
    if (Number.isFinite(medianPbrRoe) && medianPbrRoe > 0 && Number(item.roe) > 0 && Number(v.bps) > 0) {
      fairModels.push({ name: "섹터 PBR/ROE", price: medianPbrRoe * Number(item.roe) * Number(v.bps) });
    }
    const fairPrice = medianClient(fairModels.map((x) => x.price).filter((x) => x > 0));
    const discountPct = Number.isFinite(fairPrice) && fairPrice > 0 && price > 0 ? ((fairPrice - price) / fairPrice) * 100 : null;

    const fairScore = Number.isFinite(discountPct) ? linearScore(discountPct, -30, 55, 30) : 8;
    const qualityFactor = q >= 72 ? 1 : q >= 60 ? 0.72 : q >= 50 ? 0.45 : 0.25;
    const position = Number(v.position52);
    let low52Score = Number.isFinite(position) ? Math.max(0, Math.min(20, 20 * (1 - position / 100))) : 6;
    low52Score *= qualityFactor;
    if (Number(item.roe) <= 0) low52Score *= 0.2;
    if (Number(item.debtRatio) >= 200) low52Score *= 0.5;

    const pbrRoeScore = Number(v.pbrToRoe) > 0 ? lowIsGoodPercentile(Number(v.pbrToRoe), pbrRoes) * 20 : 4;
    const perScore = Number(v.per) > 0 ? lowIsGoodPercentile(Number(v.per), pers) * 15 : 0;
    let pbrScore = Number(v.pbr) > 0 ? lowIsGoodPercentile(Number(v.pbr), pbrs) * 10 : 2;
    if (Number(item.roe) <= 0) pbrScore *= 0.2;
    else if (Number(item.roe) < 5) pbrScore *= 0.55;
    const earningsYieldScore = Number(v.earningsYield) > 0 ? Math.max(0, Math.min(5, Number(v.earningsYield) / 12 * 5)) : 0;

    const warnings = [...(item.valueTrapWarnings || [])];
    let trapPenalty = Math.min(16, warnings.length * 4);
    if (Number.isFinite(position) && position <= 20 && q < 55) {
      warnings.push("52주 저가 근접이나 Quality 낮음");
      trapPenalty = Math.min(18, trapPenalty + 4);
    }
    const rawValue = fairScore + low52Score + pbrRoeScore + perScore + pbrScore + earningsYieldScore;
    const valueScore = roundClient(Math.max(0, Math.min(100, rawValue - trapPenalty)), 1);
    const baseFinalScore = roundClient(Math.max(0, Math.min(100, q * 0.45 + valueScore * 0.55)), 1);

    item.valueScore = valueScore;
    item.baseFinalScore = baseFinalScore;
    item.finalScore = baseFinalScore;
    item.finalGrade = gradeFromScoreClient(baseFinalScore);
    item.grade = item.finalGrade;
    item.score = baseFinalScore;
    item.valueTrapWarnings = [...new Set(warnings)];
    item.fairValue = {
      fairPrice: Number.isFinite(fairPrice) ? Math.round(fairPrice) : null,
      discountPct: Number.isFinite(discountPct) ? roundClient(discountPct, 1) : null,
      confidence: fairModels.length >= 3 ? "높음" : fairModels.length === 2 ? "보통" : fairModels.length === 1 ? "낮음" : "자료 부족",
      modelCount: fairModels.length,
      models: fairModels.map((x) => ({ name: x.name, price: Math.round(x.price) })),
      sectorMedianPer: Number.isFinite(medianPer) ? roundClient(medianPer, 2) : null,
      sectorMedianPbrRoe: Number.isFinite(medianPbrRoe) ? roundClient(medianPbrRoe, 4) : null,
    };
    item.valueBreakdown = {
      fairDiscount: roundClient(fairScore, 1),
      week52Position: roundClient(low52Score, 1),
      pbrRoeRelative: roundClient(pbrRoeScore, 1),
      perRelative: roundClient(perScore, 1),
      pbrRelative: roundClient(pbrScore, 1),
      earningsYield: roundClient(earningsYieldScore, 1),
      trapPenalty: roundClient(trapPenalty, 1),
    };
    return item;
  });
}

function medianClient(values) {
  const a = (values || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function lowIsGoodPercentile(value, values) {
  const a = (values || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length || !Number.isFinite(value)) return 0.3;
  if (a.length === 1) return 0.5;
  let below = 0;
  for (const x of a) if (x < value) below += 1;
  return Math.max(0, Math.min(1, 1 - below / (a.length - 1)));
}

function linearScore(value, low, high, maxScore) {
  if (!Number.isFinite(Number(value))) return 0;
  const t = Math.max(0, Math.min(1, (Number(value) - low) / (high - low)));
  return t * maxScore;
}

function targetPriceBonus(upsidePct) {
  const x = Number(upsidePct);
  if (!Number.isFinite(x) || x <= 10) return 0;
  if (x >= 50) return 4;
  if (x >= 35) return 3;
  if (x >= 20) return 2;
  return 1;
}

function gradeFromScoreClient(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "-";
  if (n >= 88) return "S";
  if (n >= 80) return "A+";
  if (n >= 72) return "A";
  if (n >= 62) return "B";
  return "C";
}

function roundClient(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function drawSectorChart(canvas, rows) {
  if (!canvas || !rows?.length) return drawEmptyChart(canvas, "섹터 지수 데이터가 없습니다.");
  const series = [
    { key: "close", label: "업종지수", color: "#172b4d", width: 2.2 },
    { key: "ma20", label: "MA20", color: "#2e7d32", width: 1.6 },
    { key: "ma60", label: "MA60", color: "#d97706", width: 1.6 },
    { key: "ma120", label: "MA120", color: "#7c3aed", width: 1.6 },
  ];
  drawLineChart(canvas, rows, series, { xKey: "date", valueFormatter: shortNumber, zeroLine: false });
}

function setSectorProgress(text, visible, percent = null, detail = "") {
  renderProgressNote(sectorProgress, text, visible, percent, detail);
}

function setRankProgress(text, visible, percent = null, detail = "") {
  renderProgressNote(rankProgress, text, visible, percent, detail);
}

function renderProgressNote(el, text, visible, percent = null, detail = "") {
  if (!el) return;
  el.classList.toggle("hidden", !visible || !text);
  if (!visible || !text) { el.innerHTML = ""; return; }
  const n = Number(percent);
  if (!Number.isFinite(n)) { el.textContent = text; return; }
  const pct = Math.max(0, Math.min(100, n));
  el.innerHTML = `<div class="energy-progress-head"><b>${escapeHtml(text)}</b><span>${escapeHtml(detail || `${Math.round(pct)}%`)}</span></div><div class="energy-track"><i style="width:${pct}%"></i><span class="energy-glow" style="left:${Math.max(0,pct-2)}%"></span></div><div class="energy-percent"><strong>${Math.round(pct)}%</strong><small>${pct >= 100 ? "분석 완료" : "데이터를 채우는 중입니다"}</small></div>`;
}


function startAnalyzeEnergy() {
  clearInterval(analyzeProgressTimer);
  let pct = 4;
  updateAnalyzeEnergy(pct);
  analyzeProgressTimer = setInterval(() => {
    const step = pct < 45 ? 4 + Math.random() * 5 : pct < 78 ? 2 + Math.random() * 3 : 0.5 + Math.random() * 1.5;
    pct = Math.min(93, pct + step);
    updateAnalyzeEnergy(pct);
  }, 420);
}

function finishAnalyzeEnergy() {
  clearInterval(analyzeProgressTimer);
  analyzeProgressTimer = null;
  updateAnalyzeEnergy(100);
}

function updateAnalyzeEnergy(percent) {
  const bar = $("analyzeEnergyBar");
  const label = $("analyzeEnergyPct");
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  if (bar) bar.style.width = `${pct}%`;
  if (label) label.textContent = `${Math.round(pct)}%`;
}

function updateNpayTopLink(code) {
  const link = $("npayTopLink");
  if (!link) return;
  const valid = /^\d{6}$/.test(code || "");
  link.href = valid ? npayUrl(code) : npayHomeUrl();
  link.classList.toggle("disabled-link", !valid);
}

function isMobileNpay() {
  const ua = navigator.userAgent || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || window.matchMedia("(max-width: 760px)").matches;
}

function npayHomeUrl() {
  return isMobileNpay() ? "https://m.stock.naver.com/" : "https://stock.naver.com/";
}

function npayUrl(code) {
  const safeCode = encodeURIComponent(code);
  return isMobileNpay()
    ? `https://m.stock.naver.com/domestic/stock/${safeCode}/total`
    : `https://stock.naver.com/domestic/stock/${safeCode}/price`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 접속키가 세션에 남아 있으면 진입 즉시 산업 목록부터 보여줍니다.
if (accessKey.value.trim()) {
  setTimeout(() => loadSectorList(), 250);
}

function setCard(id, state, text) {
  const card = $(`card-${id}`);
  if (!card) return;
  const status = card.querySelector(".status");
  const detail = card.querySelector(".detail");
  const labels = { ok: "정상", bad: "오류", warn: "확인필요", wait: "점검중", idle: "대기" };
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
      if (data.available === false) {
        setCard(p.id, "warn", data.message || "현재 선택 기능은 사용할 수 없습니다.");
        continue;
      }
      if (p.id === "dart") setCard(p.id, "ok", `${data.sample?.corpName || "기업조회 성공"} · 인증 정상`);
      if (p.id === "kis") setCard(p.id, "ok", `${fmt(data.sample?.price)}원 · 핵심 시세조회 정상`);
      if (p.id === "krx") setCard(p.id, "ok", `${data.serviceOk ?? 0}/${data.serviceTotal ?? 6}개 API 정상 · ${formatDate(data.date)}`);
      if (p.id === "ecos") setCard(p.id, "ok", `${fmt(data.rows)}개 주요지표 수신 · 인증 정상`);
    } catch (e) {
      setCard(p.id, "bad", e.message);
    }
  }
});

$("analyze").addEventListener("click", async () => {
  let code = stockCodeInput.value.trim();
  const typedQuery = (stockSearchInput?.value || "").trim();
  if (!code && /^\d{6}$/.test(typedQuery)) {
    code = typedQuery;
    setSelectedStock({ code, name: typedQuery, market: "" });
  }
  const corp = corpCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) return alert("종목코드는 6자리 숫자입니다.");
  if (corp && !/^\d{8}$/.test(corp)) return alert("DART 기업고유번호는 8자리 숫자입니다.");

  loading.classList.remove("hidden");
  result.classList.add("hidden");
  startAnalyzeEnergy();
  try {
    const q = new URLSearchParams({ code });
    if (corp) q.set("corp", corp);
    const data = await api(`/api/analyze?${q}`);
    data.rankContext = sectorState.rankings.get(code) || null;
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
    finishAnalyzeEnergy();
    await sleep(260);
    loading.classList.add("hidden");
  }
});

function renderResult(d) {
  const t = d.technical || {};
  const s = d.supply || {};
  const f = d.finance || {};
  const snap = d.snapshot || {};
  const identity = d.identity || {};
  const latestRatio = f.latestRatio || {};
  const latestAnnual = f.annual?.[0] || {};
  const supplyClass = (s.score || 0) >= 80 ? "good" : (s.score || 0) >= 50 ? "warn" : "bad";
  const techClass = t.wavePass ? "good" : "warn";
  const debtClass = Number.isFinite(Number(latestRatio.debtRatio))
    ? Number(latestRatio.debtRatio) < 150 ? "good" : "bad"
    : "neutral";
  const zoneText = zoneLabel(t.zone);
  const opMargin = margin(latestAnnual.operatingIncome, latestAnnual.revenue);
  const sourceErrors = Array.isArray(d.sourceErrors) ? d.sourceErrors : [];
  const companyName = identity.name || snap.name || d.code;
  const sectorText = identity.sector || snap.industry || identity.industryStandard || "업종정보 확인 중";
  const rankCtx = d.rankContext || sectorState.rankings.get(d.code) || null;
  setSelectedStock({ code: d.code, name: companyName, market: identity.market || "", englishName: identity.englishName || selectedStockEnglish?.textContent || "" });

  result.innerHTML = `
    <div class="result-title company-title">
      <div>
        <div class="company-name-row">
          <h3>${escapeHtml(companyName)}</h3>
          <span class="code-badge">${escapeHtml(d.code)}</span>
        </div>
        <div class="identity-badges">
          ${identity.market ? `<span class="identity-badge market-badge">${escapeHtml(identity.market)}</span>` : ""}
          ${sectorText ? `<span class="identity-badge">${escapeHtml(sectorText)}</span>` : ""}
          ${identity.industryStandard && identity.industryStandard !== sectorText ? `<span class="identity-badge subtle">${escapeHtml(identity.industryStandard)}</span>` : ""}
          <a class="mini-link npay" href="${npayUrl(d.code)}" target="_blank" rel="noopener noreferrer">Npay 차트 ↗</a>
        </div>
      </div>
      <div class="sub">분석시각 ${formatDateTime(d.analyzedAt)}</div>
    </div>

    ${sourceErrors.length ? `
      <div class="note warning-note"><b>일부 데이터만 표시 중</b><br>${sourceErrors.map((x) => `${escapeHtml(x.label)}: ${escapeHtml(x.error)}`).join("<br>")}</div>
    ` : ""}

    <div class="result-grid">
      ${rankCtx ? `
      <div class="metric value-summary-metric">
        <h3>FF 저평가 우량</h3>
        <div class="big ${Number(rankCtx.finalScore) >= 75 ? "good" : Number(rankCtx.finalScore) >= 62 ? "warn" : "neutral"}">${fmt1(rankCtx.finalScore)}/100</div>
        <div class="kv">
          <span>Quality</span><span>${fmt1(rankCtx.qualityScore)}/100</span>
          <span>Value</span><span>${fmt1(rankCtx.valueScore)}/100</span>
          <span>분기 검증</span><span class="${rankCtx.quarterlyMetrics?.testPass === true ? "pos" : rankCtx.quarterlyMetrics?.testPass === false ? "neg" : "neutral"}">${rankCtx.quarterlyMetrics?.testPass === true ? "최근 4분기 통과" : rankCtx.quarterlyMetrics?.testPass === false ? "미통과" : "자료부족"}</span>
          <span>TTM 매출/영업익</span><span>${rankCtx.quarterlyMetrics?.ttmRevenueGrowth == null ? "-" : signedPctPlain(rankCtx.quarterlyMetrics.ttmRevenueGrowth)} / ${rankCtx.quarterlyMetrics?.ttmOperatingGrowth == null ? "-" : signedPctPlain(rankCtx.quarterlyMetrics.ttmOperatingGrowth)}</span>
          <span>매집 점수</span><span>${rankCtx.accumulationScore == null ? "-" : `${fmt1(rankCtx.accumulationScore)}/100`}</span>
          <span>공시·뉴스 페널티</span><span class="${Number(rankCtx.riskPenalty) > 0 ? "neg" : "pos"}">${rankCtx.riskPenalty == null ? "-" : `-${fmt1(rankCtx.riskPenalty)}점`}</span>
          <span>FF 참고 적정가</span><span>${rankCtx.fairValue?.fairPrice ? `${fmt(rankCtx.fairValue.fairPrice)}원` : "-"}</span>
          <span>현재가 대비</span><span class="${Number(rankCtx.fairValue?.discountPct) > 0 ? "pos" : "neg"}">${rankCtx.fairValue?.discountPct == null ? "-" : `${signedPctPlain(rankCtx.fairValue.discountPct)}`}</span>
        </div>
      </div>` : ""}
      <div class="metric">
        <h3>시장 스냅샷</h3>
        <div class="big">${fmt(snap.price)}원</div>
        <div class="kv">
          <span>PER</span><span>${fmt2(snap.per)}</span>
          <span>PBR</span><span>${fmt2(snap.pbr)}</span>
          <span>52주 위치</span><span>${snap.position52 == null ? "-" : `${fmt1(snap.position52)}%`}</span>
          <span>52주 고가</span><span>${fmt(snap.high52)}</span>
          <span>52주 저가</span><span>${fmt(snap.low52)}</span>
          <span>시가총액</span><span>${snap.marketCap100MKRW == null ? "-" : `${fmt(snap.marketCap100MKRW)}억원`}</span>
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
        <h3>안정성 <span class="metric-period">${periodLabel(latestRatio.period)}</span></h3>
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
      아래 상세항목은 기본적으로 닫혀 있습니다. 필요한 항목만 눌러 펼쳐보세요. 재무 금액은 KIS 손익계산서 원자료를 표시하고, 분기 누적 여부가 확인되는 경우에만 개별 분기로 환산합니다.
    </div>

    <div class="accordions">
      ${companyAccordion(identity, snap)}
      ${priceAccordion(t)}
      ${supplyAccordion(s)}
      ${rankingSignalsAccordion(rankCtx)}
      ${annualAccordion(f.annual || [])}
      ${quarterAccordion(f.quarterly || [], f.note)}
      ${ratioAccordion(f.ratios || [], latestRatio)}
      ${dartAccordion(d.dart)}
    </div>
  `;

  result.classList.remove("hidden");
  bindAccordions(d);
}

function companyAccordion(identity, snap) {
  const sector = identity.sector || snap.industry || "-";
  return `
    <details class="accordion" id="acc-company">
      <summary><span>기업 · 시장 · 업종 정보</span><span class="accordion-meta">어디 회사인지 먼저 확인</span></summary>
      <div class="accordion-body">
        <div class="kv wide-kv">
          <span>기업명</span><span>${escapeHtml(identity.name || snap.name || "-")}</span>
          <span>영문명</span><span>${escapeHtml(identity.englishName || "-")}</span>
          <span>종목코드</span><span>${escapeHtml(identity.code || "-")}</span>
          <span>시장</span><span>${escapeHtml(identity.market || "-")}</span>
          <span>대표 업종/섹터</span><span>${escapeHtml(sector)}</span>
          <span>업종 대분류</span><span>${escapeHtml(identity.industryLarge || "-")}</span>
          <span>업종 중분류</span><span>${escapeHtml(identity.industryMedium || "-")}</span>
          <span>업종 소분류</span><span>${escapeHtml(identity.industrySmall || "-")}</span>
          <span>표준산업분류</span><span>${escapeHtml(identity.industryStandard || "-")}</span>
          <span>결산월</span><span>${escapeHtml(identity.fiscalMonth ? `${identity.fiscalMonth}월` : "-")}</span>
          <span>상장일</span><span>${escapeHtml(formatDate(identity.listedDate))}</span>
        </div>
      </div>
    </details>`;
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


function rankingSignalsAccordion(rankCtx) {
  if (!rankCtx) return "";
  const q = rankCtx.quarterlyMetrics || {};
  const acc = rankCtx.accumulation || {};
  const risk = rankCtx.risk || {};
  const disclosureItems = risk.disclosure?.items || [];
  const newsItems = risk.news?.headlines || [];
  return `
    <details class="accordion" id="acc-ff-signals">
      <summary><span>FF 핵심 검증 · 분기 일관성 · 매집 · 리스크</span><span class="accordion-meta">점수의 근거 확인</span></summary>
      <div class="accordion-body">
        <div class="ratio-grid">
          <div class="ratio-card"><div class="label">분기 Train/Test</div><div class="value ${q.testPass === true ? "good" : q.testPass === false ? "bad" : "neutral"}">${q.testPass === true ? "통과" : q.testPass === false ? "미통과" : "자료부족"}</div><div class="hint">과거 구간과 최근 4분기를 분리해 성장 지속성을 확인</div></div>
          <div class="ratio-card"><div class="label">TTM 매출 성장</div><div class="value ${signClass(q.ttmRevenueGrowth)}">${q.ttmRevenueGrowth == null ? "-" : signedPctPlain(q.ttmRevenueGrowth)}</div><div class="hint">최근 4분기 합계 vs 직전 4분기 합계</div></div>
          <div class="ratio-card"><div class="label">TTM 영업이익 성장</div><div class="value ${signClass(q.ttmOperatingGrowth)}">${q.ttmOperatingGrowth == null ? "-" : signedPctPlain(q.ttmOperatingGrowth)}</div><div class="hint">한 분기 급증보다 4분기 누적 개선을 우대</div></div>
          <div class="ratio-card"><div class="label">매집 점수</div><div class="value ${Number(rankCtx.accumulationScore) >= 68 ? "good" : "neutral"}">${rankCtx.accumulationScore == null ? "-" : `${fmt1(rankCtx.accumulationScore)}/100`}</div><div class="hint">외국인·기관 지속매수 + 거래량 + 가격 조합</div></div>
          <div class="ratio-card"><div class="label">1년 주가</div><div class="value ${Number(rankCtx.price1yChangePct) < 0 && Number(q.ttmRevenueGrowth) > 0 ? "good" : signClass(rankCtx.price1yChangePct)}">${rankCtx.price1yChangePct == null ? "-" : signedPctPlain(rankCtx.price1yChangePct)}</div><div class="hint">실적 개선인데 주가가 전년보다 낮으면 괴리 가점</div></div>
          <div class="ratio-card"><div class="label">공시·뉴스 위험</div><div class="value ${Number(rankCtx.riskPenalty) > 0 ? "bad" : "good"}">${rankCtx.riskPenalty == null ? "-" : `-${fmt1(rankCtx.riskPenalty)}점`}</div><div class="hint">DART를 우선하고 뉴스는 낮은 가중치의 보조신호</div></div>
        </div>
        ${acc.signals?.length ? `<div class="note"><b>매집 후보 신호</b><br>${acc.signals.map(x=>`• ${escapeHtml(x)}`).join("<br>")}${acc.penalties?.length ? `<br><br><b>분배 경고</b><br>${acc.penalties.map(x=>`• ${escapeHtml(x)}`).join("<br>")}` : ""}</div>` : ""}
        ${disclosureItems.length ? `<div class="table-wrap table-gap"><table><thead><tr><th>공시일</th><th>위험 공시</th><th>감점</th></tr></thead><tbody>${disclosureItems.map(x=>`<tr><td>${formatDate(x.date)}</td><td>${escapeHtml(x.title)}</td><td class="neg">-${fmt1(x.weight)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="note">최근 1년 DART 위험공시: ${escapeHtml(risk.disclosure?.message || "상위 후보에서 자동 확인")}</div>`}
        ${newsItems.length ? `<div class="note"><b>뉴스 위험 키워드 보조검색</b><br>${newsItems.slice(0,5).map(x=>`• ${escapeHtml(x.title)}`).join("<br>")}<br><small>뉴스 제목 기반 신호는 오탐 가능성이 있어 공시보다 낮은 가중치를 적용합니다.</small></div>` : ""}
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
      <summary><span>안정성 · 유보율 · 부채비율</span><span class="accordion-meta">최근 공시 + 연간 추세</span></summary>
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

function fmt1(v) {
  return isFiniteValue(v) ? Number(v).toLocaleString("ko-KR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "-";
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

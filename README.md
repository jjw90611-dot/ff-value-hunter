# FF Value Hunter v0.5

산업의 흐름을 먼저 찾고, 그 산업 안에서 재무적으로 우량한 기업을 선별한 뒤 수급과 가격을 검증하는 개인용 가치투자 스캐너입니다.

> 자동매수/자동매도 기능은 없습니다. 주문 API를 사용하지 않습니다.

## v0.5 핵심 개선

### 1. 초보자용 2026형 UI 전면 개편

화면을 `STEP 1 산업 → STEP 2 기업 → STEP 3 검증` 순서로 단순화했습니다.

- 상승 산업/섹터를 카드로 표시
- 전체 섹터 수, 70점 이상 상승 섹터 수, 정배열 섹터 수를 상단에서 바로 확인
- 섹터 클릭 시 관련기업을 표가 아니라 카드 형태로 표시
- 우량기업 분석 후 3년 매출, 부채비율, 유보율, ROE, 영업이익을 한 카드에서 확인
- PC / 태블릿 / 모바일 반응형

### 2. 기업명 자동완성 검색

STEP 3에서 종목코드를 몰라도 됩니다.

- 회사명 검색: `삼성전자`
- 종목코드 검색: `005930`
- 주요 영문명/브랜드 검색: `Samsung`, `Hyundai`, `POSCO`, `SK hynix` 등
- 검색 결과에서 기업을 클릭하면 종목코드가 자동 선택됨
- 방향키 ↑/↓ + Enter 선택 지원
- `Ctrl+K` 또는 `Cmd+K`로 기업 검색창 바로 포커스

API:

```text
GET /api/search-stocks?q=삼성&limit=12
```

검색은 KIS 공식 KOSPI/KOSDAQ 종목 마스터를 사용하며, 종목 마스터는 Worker Cache에 저장합니다.

### 3. 영문 기업명 표시

주요 대형주는 실제 통용 영문명을 우선 표시하고, 그 외 종목은 검색 편의를 위한 영문 alias를 보조적으로 생성합니다.

예:

```text
삼성전자
Samsung Electronics
005930 · KOSPI
```

### 4. Npay 증권 연결

기업 카드 또는 상세분석에서 `Npay 차트` 버튼을 누르면 현재 Npay 증권 종목 페이지를 새 탭으로 엽니다.

```text
https://m.stock.naver.com/domestic/stock/{종목코드}/total
```

### 5. DART 기업고유번호는 고급 옵션으로 이동

일반 사용자는 기업명만 검색하면 됩니다. DART 기업고유번호는 공시 연결이 필요할 때만 선택 입력합니다.

## 투자 흐름

```text
전체 KOSPI/KOSDAQ 산업
        ↓
산업지수 MA20 / MA60 / MA120
        ↓
지속 상승 섹터 우선 정렬
        ↓
관련 기업 목록
        ↓
3년 매출 성장 + 영업이익 + 안정성
        ↓
외국인·기관 지속 매집
        ↓
가격 위치 / Npay 증권 차트
        ↓
최종 기업 검증
```

## 우량기업 점수

- 최근 3개년 매출 우상향: 최대 30점
- 영업이익 안정성/증가: 최대 20점
- 부채비율: 최대 20점
- 유보율: 최대 10점
- ROE: 최대 10점
- 영업이익률: 최대 10점

부채비율 150% 미만을 FF 안정성 기준에서 우대합니다.

## Cloudflare Secrets

v0.4와 동일합니다. 새 API 키는 필요 없습니다.

```text
APP_ACCESS_KEY
DART_API_KEY
KIS_APP_KEY
KIS_APP_SECRET
KRX_AUTH_KEY
ECOS_API_KEY
```

산업/기업 검색과 핵심 분석은 KIS가 중심입니다. DART/KRX/ECOS는 보조 기능입니다.

## 배포

1. ZIP을 압축 해제합니다.
2. 기존 GitHub 저장소 파일을 v0.5 파일로 교체합니다.
3. Commit / Push 합니다.
4. Cloudflare Workers Builds 배포 완료를 확인합니다.
5. 기존 Variables and Secrets는 그대로 유지합니다.
6. 사이트에서 접속키를 적용합니다.
7. `섹터 불러오기 → 상승 흐름 분석 → 섹터 선택 → 우량기업 순으로 정렬` 순서로 사용합니다.

## 개발 명령

```bash
npm install
npm run dev
npm run deploy
```

## KIS 호출 제한 대응

- OAuth 토큰 캐시/재사용
- KIS 호출 직렬화
- 호출 간 최소 간격
- rate-limit 응답 자동 재시도
- 섹터 추세 4시간 캐시
- 종목 마스터 12시간 캐시

## 파일 구조

```text
ff-value-hunter-v0.5/
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
├─ src/
│  └─ worker.js
├─ package.json
├─ wrangler.jsonc
├─ .dev.vars.example
├─ .gitignore
└─ README.md
```

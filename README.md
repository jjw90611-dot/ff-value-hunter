# FF Value Hunter v0.1

GitHub + Cloudflare Workers용 가치투자 분석기 스타터입니다.

이 버전의 목적은 **자동매수/자동매도**가 아니라 다음 2가지를 먼저 검증하는 것입니다.

1. OpenDART / KIS / KRX / ECOS API가 Cloudflare에서 정상 연결되는지 확인
2. 한 종목을 넣었을 때 수급과 MA20/60/120 분석이 정상 작동하는지 확인

## 현재 구현

- API 연결 점검 화면
- KIS 현재가: PER, PBR, 외국인 보유수량/소진율 등
- KIS 일봉: MA20 / MA60 / MA120, 정배열, 60/120일선 가격구간
- KIS 투자자: 외국인/기관 5일, 20일, 30일 누적 순매수
- 외국인/기관 순매수 지속성 가점
- 외국인 보유비율(소진율) 30일 변화 가점
- DART 기업개황 및 최신 연간 재무 스냅샷(기업고유번호 입력 시)
- KRX, ECOS API 연결 테스트
- 주문 API는 전혀 구현하지 않음

## 중요: 기관 보유량

KIS의 이 버전에서 사용하는 투자자 엔드포인트는 기관의 실제 보유수량 시계열을 직접 주지 않습니다. 따라서 v0.1은 **기관 누적 순매수**를 보유 확대의 대용지표로 사용합니다. 외국인은 최근 일별 외국인 소진율 변화를 함께 봅니다.

---

# 1. GitHub에 올리기

새 저장소를 만든 뒤 이 ZIP의 **최상위 파일과 폴더를 그대로** 올립니다.

루트에 아래 파일이 보여야 합니다.

```text
package.json
wrangler.jsonc
README.md
src/
public/
```

`ff-value-hunter-v0.1` 폴더를 한 번 더 감싸서 올리지 않는 것을 권장합니다.

---

# 2. Cloudflare에 GitHub 연결

Cloudflare Dashboard에서:

```text
Workers & Pages
→ Create application
→ Import a repository
→ GitHub 저장소 선택
→ Save and Deploy
```

이 프로젝트는 `wrangler.jsonc`가 이미 있으므로 별도 프레임워크 설정이 필요 없습니다.

권장 빌드 설정:

```text
Production branch: main
Build command: 비워도 됨
Deploy command: npx wrangler deploy
Root directory: /
```

Cloudflare Workers Builds는 저장소에 push가 들어오면 자동 배포할 수 있습니다.

---

# 3. API 키를 Cloudflare Secret으로 넣기

Cloudflare의 해당 Worker에서:

```text
Settings
→ Variables & Secrets
→ Add
```

아래 이름을 **정확히** 등록합니다.

```text
DART_API_KEY
KIS_APP_KEY
KIS_APP_SECRET
KRX_AUTH_KEY
ECOS_API_KEY
APP_ACCESS_KEY
```

`APP_ACCESS_KEY`는 API 발급키가 아닙니다. 본인이 임의로 만드는 개인 접속 비밀번호입니다.

예:

```text
APP_ACCESS_KEY = ff-my-private-password-2026
```

가능하면 길고 추측하기 어렵게 만드세요.

## 절대 하지 말 것

실제 키를 GitHub 파일에 쓰지 마세요.

```js
// 금지
const KIS_APP_SECRET = "실제키";
```

이 프로젝트는 서버에서 `env.KIS_APP_SECRET`처럼 Cloudflare Secret을 읽습니다.

---

# 4. 첫 점검

배포가 끝나면 사이트에 접속합니다.

1. `APP_ACCESS_KEY`를 설정했다면 첫 칸에 입력 후 **적용**
2. **전체 연결 점검** 클릭
3. DART / KIS / KRX / ECOS가 모두 `정상`인지 확인

### KRX만 오류가 나는 경우

KRX는 인증키 발급과 별개로 **API 서비스별 활용 승인**이 필요합니다. v0.1 테스트는 `유가증권 일별매매정보`를 사용합니다. 해당 서비스가 승인되었는지 확인하세요.

### KIS 토큰 오류가 나는 경우

KIS는 OAuth Access Token을 발급한 뒤 시세 API를 호출합니다. v0.1은 Worker 인스턴스 메모리에 토큰을 잠시 캐시합니다. 전체 종목 스캐너를 만드는 v0.2에서는 KV/D1을 이용해 토큰/데이터 호출량을 더 안정적으로 관리할 예정입니다.

---

# 5. 첫 종목 분석

기본 샘플:

```text
삼성전자 종목코드: 005930
DART 기업고유번호: 00126380
```

`분석 실행`을 누르면 다음을 표시합니다.

- PER / PBR
- 외국인 보유수량 / 소진율
- MA20 / MA60 / MA120
- 정배열 및 10거래일 기울기
- 60일선~120일선 가격 구간 여부
- 외국인 5/20/30일 누적 순매수
- 기관 5/20/30일 누적 순매수
- 외국인/기관 동반 순매수일
- 외국인 보유비율 변화
- DART 매출 / 영업이익 / 순이익 / 자산 / 부채

---

# 6. 수급 가점 v0.1

수급점수 100점 구조입니다.

```text
외국인 5일 누적 순매수          +5
외국인 20일 누적 순매수        +10
외국인 30일 누적 순매수        +10
외국인 20일 중 순매수 12일+    +10
외국인 현재 연속 순매수 3일+     +5
외국인 보유비율 상승            +10

기관 5일 누적 순매수            +5
기관 20일 누적 순매수          +10
기관 30일 누적 순매수          +10
기관 20일 중 순매수 12일+      +10
기관 현재 연속 순매수 3일+       +5

외국인+기관 20일 모두 누적+       +5
동반 순매수 20일 중 8일+          +5
```

핵심은 **하루 대량 순매수보다 지속적인 누적 매수와 보유 확대에 더 높은 의미를 두는 것**입니다.

---

# 7. 다음 버전 v0.2

v0.1에서 API가 모두 정상인 것을 확인하면 다음 단계로 넘어갑니다.

- Cloudflare D1 추가
- KOSPI/KOSDAQ 전체 종목 Universe 저장
- 종목코드 ↔ DART 기업고유번호 자동매핑
- 업종별 KIS/KRX 지수 저장
- 산업 MA20/60/120 정배열 자동판정
- 재무 3~5년 추세 계산
- 부채비율 150% 이하 필터
- 영업이익 성장성
- CB/BW/유상증자/감자 위험공시
- PER/PBR 업종 상대평가
- 외국인/기관 누적수급
- FF 후보 TOP 20
- S/A/B/보류 등급
- 장 마감 후 자동 업데이트

## 주문 기능

이 프로젝트에는 매수/매도 주문 API를 추가하지 않습니다.

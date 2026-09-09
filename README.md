# FF Value Hunter v1.0

산업 → 저평가 우량기업 → **Loopera's Advice Evidence Gate** → 선택기업 상세검증 순으로 후보를 좁히는 개인용 가치투자 연구 도구입니다.

> 자동 매수/매도 기능은 없으며 주문 API를 사용하지 않습니다.

## v1.0 핵심: STEP 3 Loopera's Advice

STEP 2의 높은 FF 점수를 그대로 믿지 않고, 상위 후보를 한 번 더 **가설 → 반대가설 → 회계원문 → Train/Test 안정성 → 독립 증거 → Research Memory** 순으로 검증합니다.

Loopera 공개 문서의 연구 원칙(Hypothesis-driven, Evidence-gated, Research Memory, competing mechanisms, invalidation conditions)을 참고한 **독립 구현**입니다. Loopera 소스코드나 비공개 파라미터를 복사하지 않습니다.

### Evidence Gates

1. **데이터·Coverage**: 분기/연간/Value/수급/공시/회계 원문 데이터가 충분한지
2. **정보시점**: 현재 공개된 정보만 사용하는지. 과거 point-in-time 재구성은 별도 백테스트 전까지 완전 통과로 간주하지 않음
3. **회계정의·현금**: OpenDART 전체재무제표와 대조하고 영업현금흐름/영업이익 등 현금전환을 확인
4. **경제적 논리**: 실적 성장, 영업이익률, 저평가, 수급, 안정성, 산업 파도가 서로 같은 방향을 지지하는지
5. **Train→Test 안정성**: 과거 구간의 성장 패턴이 최근 4분기에서도 유지되는지, 단일 분기 스파이크인지
6. **독립 증거**: Quality/Value/Accumulation/실적-가격 괴리/현금흐름/리스크가 서로 다른 축에서 지지하는지

`독립 증거` Gate는 현재 **Incremental Residual IC의 대체값이 아닙니다.** 실제 Rank IC, Neutralized IC, Incremental Residual IC, Sharpe, MDD, Walk-forward, 독립 OOS 성과는 과거 시점별 cross-sectional panel DB를 구축한 뒤에만 계산할 수 있으므로 v1.0에서는 임의로 만들지 않습니다.

### Research Contract

각 후보에 다음을 같이 표시합니다.

- Primary hypothesis
- 경제적 메커니즘
- 지지 증거
- 반대 증거 / competing mechanisms
- 다음 분기에서 가설이 깨지는 invalidation conditions
- 회계 원문 확인 결과

### Research Memory

Evidence Gate 결과는 브라우저 `localStorage`에 최대 30개까지 저장합니다. 같은 회사를 다시 검토할 때 과거 판단과 비교하기 위한 연구 기록이며, 검증된 수익률 데이터베이스를 의미하지 않습니다.

## 기존 FF 점수 구조

### Quality
- 최근 분기 성장·일관성 50
- 연간 성장 15
- 부채비율/유보율 15
- ROE/영업이익률 10
- 연간·분기 흑자 지속성 10
- 한 분기 일회성 급증 최대 -8

최근 분기는 과거 `Train`과 최근 4분기 `Test`로 나누며 TTM 매출/영업이익 성장, 전년동기 증가 비율, 영업이익률 기울기를 같이 봅니다.

### Value
- 기계적 참고 적정가 대비 할인
- 52주 최저~최고 위치
- 동일 섹터 PER/PBR 상대순위
- PBR/ROE 상대순위
- Earnings Yield
- TTM 실적 성장 + 1년 주가 하락의 Fundamental-Price Divergence

낮은 시가총액 자체는 저평가 점수로 사용하지 않습니다.

### Accumulation
- 외국인 5/20/30일 누적순매수
- 기관 5/20/30일 누적순매수
- 외국인/기관 동반 순매수
- 외국인 보유비율 증가
- 가격 횡보 중 누적매수
- 상승 중 거래량 감소 + 수급 양호
- 거래량 점진 증가
- 고거래량 긴 윗꼬리/약한 종가 반복은 분배 가능성 경고

### Risk penalty
OpenDART 최근 공시를 우선 확인하고 뉴스 제목은 낮은 가중치 보조신호로만 사용합니다.

- 횡령/배임, 감사의견거절, 상장폐지, 회생절차, 영업정지
- 감자
- 유상증자
- CB/BW/EB
- 최대주주 변경/경영권 분쟁
- 주요 소송/과징금

## 최종 STEP 2 점수

```text
FF = Quality 40% + Value 40% + Accumulation 20% - Risk penalty
```

증권사 목표가는 상위후보에서 최대 +2점 보조자료로만 사용합니다.

## v1.0 DART 회계 원문 대조

Loopera's Advice 실행 시 종목코드 → DART 고유번호를 자동 매핑하고, 사용 가능한 최신 정기보고서의 전체재무제표를 조회합니다.

가능할 때 다음을 대조합니다.
- 매출액
- 영업이익
- 당기순이익
- 영업활동현금흐름
- 재고자산
- 매출채권
- 현금및현금성자산
- 자산/부채/자본총계
- CFO / 영업이익
- CFO / 순이익

KIS 분기 데이터와 DART 원문은 연결/별도, 누적/개별분기 기준이 다를 수 있어 완전히 같은 숫자라고 가정하지 않습니다.

## 데이터 역할

- **KRX**: 전체시장/종목 기본 시장데이터
- **KIS**: 산업지수, 가격, 분기·연간 실적, 재무비율, 외국인·기관, 거래량
- **OpenDART**: 위험공시, 기업고유번호, 최신 회계 원문 대조
- **ECOS**: 거시환경 보조
- **Google News RSS**: 위험 키워드 보조(오탐 가능, 낮은 가중치)

## 필요한 Cloudflare Secrets

```text
APP_ACCESS_KEY
DART_API_KEY
KIS_APP_KEY
KIS_APP_SECRET
KRX_AUTH_KEY
ECOS_API_KEY
```

v1.0 추가 API Key는 없습니다.

## 배포

1. ZIP 압축 해제
2. 기존 GitHub 저장소 파일 전체 교체
3. Commit / Push
4. Cloudflare Workers 배포 확인
5. 기존 Secret 유지
6. `섹터 불러오기 → 상승 흐름 분석 → 섹터 선택 → 저평가 우량주 분석 → Loopera's Advice → STEP 4 상세검증`

`.gitattributes`가 JS/HTML/CSS/JSON/MD 파일을 LF 줄바꿈으로 고정합니다.

## Loopera 라이선스 주의

Loopera 저장소의 현재 LICENSE는 Business Source License 1.1이며 Additional Use Grant가 없는 형태입니다. v1.0은 해당 코드를 제품에 포함하지 않고 공개 README에서 설명한 연구 방법론을 참고해 독립적으로 작성했습니다. 서비스/프로덕션에서 Loopera 코드를 직접 재사용하려면 원 라이선스를 별도로 검토해야 합니다.

## 해석 주의

- Evidence Gate 점수는 수익 보장이나 매수 추천이 아닙니다.
- 낮은 PBR/PER/52주 저가 근접만으로 저평가라고 판단하지 않습니다.
- 거래량/수급은 특정 주체의 의도를 확정하는 증거가 아닙니다.
- 뉴스 제목 기반 위험감지는 오탐 가능성이 있습니다.
- 실제 미래 예측력을 주장하려면 point-in-time 패널, survivorship-bias 통제, 업종/시총 중립화, train/validation/test, walk-forward 및 독립 OOS 검증이 추가되어야 합니다.

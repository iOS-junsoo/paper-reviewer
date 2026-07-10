#!/usr/bin/env node
/**
 * figure_crop_report.js — 그림 해설 크롭 회귀 하니스 (계획 1 · 5단계, LLM 호출 없음 = 무료)
 *
 * 보유 논문 전체 × figure_guide의 크롭 박스를 legacy(개선 전: 캡션 텍스트 스캔만)와
 * full(개선 후: L1 임베디드 이미지 → L2 잉크 밀도 → L3 텍스트 스캔 + L4 검증) 두 라우팅으로
 * 일괄 계산하고, 각 결과를 저해상 PGM으로 실측해 백지율(잉크<1%)·절단율(변 잉크>15%)을
 * before/after로 비교한다. poppler만 사용.
 *
 * 사용법: node scripts/figure_crop_report.js [--json out.json] [--host http://localhost:3000]
 * 종료코드: full이 legacy보다 백지·절단 합계가 나빠지면 1 (회귀), 아니면 0.
 */
const fs = require("fs");
const path = require("path");
const { resolveFigureBox, measureBox } = require("../lib/figurebox");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const HOST = opt("--host", `http://localhost:${process.env.PORT || 3000}`);
const JSON_OUT = opt("--json", null);
const PDF_DIR = path.join(__dirname, "..", "pdfs");
const PAD = 0.015; // 서버 /api/figure와 동일한 패딩
const clamp01 = (n) => Math.min(Math.max(0, n), 1);

async function main() {
  const list = await fetch(`${HOST}/api/history`).then((r) => r.json());
  if (!Array.isArray(list)) throw new Error("히스토리 조회 실패 — 서버(3000)가 떠 있어야 합니다.");

  const rows = [];
  let papers = 0;
  for (const it of list) {
    const rec = await fetch(`${HOST}/api/history/${it.hash}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const figs = rec && Array.isArray(rec.figure_guide) ? rec.figure_guide : [];
    const pdfPath = path.join(PDF_DIR, `${it.hash}.pdf`);
    if (!figs.length || !fs.existsSync(pdfPath)) continue;
    papers++;
    // 페이지 크기: pdf-lib 없이 poppler로 — pdftoppm PGM의 픽셀비로 충분하지만
    // resolveFigureBox는 pt 단위가 필요하므로 pdfinfo류 대신 pdf-lib 사용(이미 의존성).
    const { PDFDocument } = require("pdf-lib");
    const doc = await PDFDocument.load(await fs.promises.readFile(pdfPath), { updateMetadata: false });
    for (const f of figs) {
      const page = Number(f.page);
      const bbox = Array.isArray(f.bbox) ? f.bbox.map(Number) : null;
      if (!Number.isInteger(page) || page < 1 || page > doc.getPageCount()) continue;
      if (!bbox || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) continue;
      let [x0, y0, x1, y1] = bbox;
      if (x1 < x0) [x0, x1] = [x1, x0];
      if (y1 < y0) [y0, y1] = [y1, y0];
      const { width: wpt, height: hpt } = doc.getPage(page - 1).getSize();
      const row = { hash: it.hash.slice(0, 8), title: (rec.title || "").slice(0, 30), label: f.label || "?", page };
      for (const mode of ["legacy", "full"]) {
        try {
          const r = await resolveFigureBox(pdfPath, page, f.label || "", [x0, y0, x1, y1], wpt, hpt, { mode });
          const padded = [clamp01(r.box[0] - PAD), clamp01(r.box[1] - PAD), clamp01(r.box[2] + PAD), clamp01(r.box[3] + PAD)];
          const m = await measureBox(pdfPath, page, padded);
          row[mode] = {
            layer: r.layer,
            box: r.box.map((v) => +v.toFixed(3)),
            ink: m ? +m.ink.toFixed(4) : null,
            blank: m ? m.ink < 0.01 : null,
            cut: m ? Object.values(m.edges).some((v) => v > 0.15) : null,
            cut_edges: m ? Object.entries(m.edges).filter(([, v]) => v > 0.15).map(([k]) => k).join(",") : "",
          };
        } catch (e) {
          row[mode] = { error: e.message.slice(0, 80) };
        }
      }
      rows.push(row);
      process.stdout.write(".");
    }
  }
  console.log("");

  const agg = (mode) => {
    const ok = rows.filter((r) => r[mode] && !r[mode].error);
    const blank = ok.filter((r) => r[mode].blank).length;
    const cut = ok.filter((r) => r[mode].cut).length;
    const layers = {};
    ok.forEach((r) => { layers[r[mode].layer] = (layers[r[mode].layer] || 0) + 1; });
    return { n: ok.length, blank, cut, blank_pct: ok.length ? ((blank / ok.length) * 100).toFixed(1) : "-", cut_pct: ok.length ? ((cut / ok.length) * 100).toFixed(1) : "-", layers };
  };
  const L = agg("legacy"), F = agg("full");
  console.log(`\n=== 그림 크롭 회귀 리포트 — 논문 ${papers}편 · 그림/표 ${rows.length}개 ===`);
  console.log(`legacy(개선 전): 백지 ${L.blank}/${L.n} (${L.blank_pct}%) · 절단 ${L.cut}/${L.n} (${L.cut_pct}%) · 레이어 ${JSON.stringify(L.layers)}`);
  console.log(`full  (개선 후): 백지 ${F.blank}/${F.n} (${F.blank_pct}%) · 절단 ${F.cut}/${F.n} (${F.cut_pct}%) · 레이어 ${JSON.stringify(F.layers)}`);

  // 케이스별 변화 (나빠진 것 우선 표시)
  const worse = rows.filter((r) => r.legacy && r.full && !r.legacy.error && !r.full.error &&
    ((!r.legacy.blank && r.full.blank) || (!r.legacy.cut && r.full.cut)));
  const better = rows.filter((r) => r.legacy && r.full && !r.legacy.error && !r.full.error &&
    ((r.legacy.blank && !r.full.blank) || (r.legacy.cut && !r.full.cut)));
  console.log(`\n개선: ${better.length}건 · 악화: ${worse.length}건`);
  worse.slice(0, 20).forEach((r) =>
    console.log(`  ⚠ ${r.hash} ${r.label} p${r.page} [${r.title}] legacy(ink ${r.legacy.ink}, cut ${r.legacy.cut_edges || "-"}) → full(${r.full.layer}, ink ${r.full.ink}, cut ${r.full.cut_edges || "-"})`));
  better.slice(0, 20).forEach((r) =>
    console.log(`  ✓ ${r.hash} ${r.label} p${r.page} [${r.title}] legacy(ink ${r.legacy.ink}, cut ${r.legacy.cut_edges || "-"}) → full(${r.full.layer}, ink ${r.full.ink}, cut ${r.full.cut_edges || "-"})`));

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ papers, total: rows.length, legacy: L, full: F, rows }, null, 2));
    console.log(`\n상세 저장: ${JSON_OUT}`);
  }
  // 회귀 판정: 두 모드 모두 측정된 공통 표본에서 (백지+절단) 건수를 비교
  const both = rows.filter((r) => r.legacy && r.full && !r.legacy.error && !r.full.error && r.legacy.ink != null && r.full.ink != null);
  const bad = (m) => both.filter((r) => r[m].blank || r[m].cut).length;
  const lBad = bad("legacy"), fBad = bad("full");
  const regressed = fBad > lBad;
  console.log(`\n공통 표본 ${both.length}개: legacy 불량 ${lBad} vs full 불량 ${fBad} → ${regressed ? "❌ 회귀" : "✅ 개선/유지"}`);
  process.exit(regressed ? 1 : 0);
}
main().catch((e) => { console.error("오류:", e.message); process.exit(2); });

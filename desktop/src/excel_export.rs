//! Excel export for the Workbook view (`WorkbookView.tsx`'s `exportExcel`).
//!
//! Built with `rust_xlsxwriter` instead of a JS library because the optional
//! "cost code" summary columns rely on Excel 365 dynamic-array formulas
//! (`LET`/`FILTER`/`UNIQUE`/`BYROW`/`VSTACK`/`EXPAND`) that only spill correctly
//! when the file carries the `XLDAPR` dynamic-array cell metadata — something no
//! JS `.xlsx` writer produces, but `write_dynamic_formula` does natively.

use rust_xlsxwriter::{
    column_number_to_name, Color, ConditionalFormatFormula, Format, FormatAlign, FormatBorder,
    FormatPattern, Workbook, XlsxError,
};
use serde::Deserialize;

/// How many rows below the summary block's anchor to pre-format with conditional
/// formatting. The block's real height is only known once Excel recalculates the
/// spill, so this just needs to be generously larger than any realistic distinct
/// cost-code count.
const SPILL_CF_ROWS: u32 = 200;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRow {
    pub row_kind: Option<String>, // "header" | "footer" | absent for a real line item
    pub section_code: String,
    pub section_desc: String,
    pub code: String,
    pub desc: String,
    pub qty: Option<f64>,
    pub unit: String,
    pub rate: Option<f64>,
    pub subtotal: Option<f64>,
    pub factor: Option<f64>,
    pub total: Option<f64>,
    pub lab: Option<f64>,
    pub lab_total: Option<f64>,
    pub mat: Option<f64>,
    pub mat_total: Option<f64>,
    pub sub: Option<f64>,
    pub sub_total: Option<f64>,
    pub sum: Option<f64>,
    pub sum_total: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcelExportPayload {
    pub include_section_cols: bool,
    pub include_cost_codes: bool,
    /// Resolved value of the project's `lab_rate` named cell, if any — used as the
    /// blended labour rate for the "TOTAL Labour" per-row formula.
    pub lab_rate: Option<f64>,
    pub rows: Vec<ExportRow>,
}

#[tauri::command]
pub async fn export_workbook_excel(path: String, payload: ExcelExportPayload) -> Result<(), String> {
    build_workbook(&payload)
        .and_then(|mut wb| wb.save(&path))
        .map_err(|e| format!("Failed to write Excel export: {e}"))
}

/// Which flattened field (or synthetic cost-code column) a given output column holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ColKind {
    SectionCode,
    SectionDesc,
    Code,
    Desc,
    Qty,
    Unit,
    Rate,
    Subtotal,
    Factor,
    Total,
    Lab,
    LabTotal,
    CostCodeLab,
    TotalLab,
    HoursTotal,
    Mat,
    MatTotal,
    CostCodeMat,
    TotalMat,
    Sub,
    SubTotal,
    CostCodeSub,
    TotalSub,
    Sum,
    SumTotal,
    CostCodeSum,
    TotalSum,
}

struct ColSpec {
    kind: ColKind,
    header: &'static str,
    width: f64,
}

const MONEY_FMT: &str = "#,##0.00";
const FACTOR_FMT: &str = "0.00";

fn build_columns(include_section_cols: bool, include_cost_codes: bool) -> Vec<ColSpec> {
    let mut cols = Vec::new();
    let mut push = |kind: ColKind, header: &'static str, width: f64| {
        cols.push(ColSpec { kind, header, width });
    };

    if include_section_cols {
        push(ColKind::SectionCode, "Section Code", 14.0);
        push(ColKind::SectionDesc, "Section", 32.0);
    }
    push(ColKind::Code, "Code", 12.0);
    push(ColKind::Desc, "Description", 40.0);
    push(ColKind::Qty, "Quantity", 12.0);
    push(ColKind::Unit, "Unit", 10.0);
    push(ColKind::Rate, "Rate", 12.0);
    push(ColKind::Subtotal, "Subtotal", 14.0);
    push(ColKind::Factor, "Factor", 10.0);
    push(ColKind::Total, "Total", 14.0);
    push(ColKind::Lab, "Lab", 10.0);
    push(ColKind::LabTotal, "Lab - Total", 14.0);
    if include_cost_codes {
        push(ColKind::CostCodeLab, "Cost Code - Labour", 14.0);
        push(ColKind::TotalLab, "TOTAL Labour", 14.0);
        push(ColKind::HoursTotal, "HOURS - Total", 12.0);
    }
    push(ColKind::Mat, "Mat", 10.0);
    push(ColKind::MatTotal, "Mat - Total", 14.0);
    if include_cost_codes {
        push(ColKind::CostCodeMat, "Cost Code - Mat", 14.0);
        push(ColKind::TotalMat, "TOTAL Mat", 14.0);
    }
    push(ColKind::Sub, "Sub", 10.0);
    push(ColKind::SubTotal, "Sub - Total", 14.0);
    if include_cost_codes {
        push(ColKind::CostCodeSub, "Cost Code - Sub", 14.0);
        push(ColKind::TotalSub, "TOTAL Sub", 14.0);
    }
    push(ColKind::Sum, "Sum", 10.0);
    push(ColKind::SumTotal, "Sum - Total", 14.0);
    if include_cost_codes {
        push(ColKind::CostCodeSum, "Cost Code - Sum", 14.0);
        push(ColKind::TotalSum, "TOTAL Sum", 14.0);
    }

    cols
}

fn col_index(cols: &[ColSpec], kind: ColKind) -> Option<u16> {
    cols.iter().position(|c| c.kind == kind).map(|i| i as u16)
}

fn build_workbook(payload: &ExcelExportPayload) -> Result<Workbook, XlsxError> {
    let cols = build_columns(payload.include_section_cols, payload.include_cost_codes);

    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet().set_name("Workbook")?;

    let header_fmt = Format::new()
        .set_bold()
        .set_pattern(FormatPattern::Solid)
        .set_background_color(Color::RGB(0xE0E0E0));
    let section_header_fmt = Format::new()
        .set_bold()
        .set_pattern(FormatPattern::Solid)
        .set_background_color(Color::RGB(0xD9D9D9));
    let section_footer_fmt = Format::new()
        .set_bold()
        .set_pattern(FormatPattern::Solid)
        .set_background_color(Color::RGB(0xFFF2CC));
    let money_fmt = Format::new().set_num_format(MONEY_FMT);
    let factor_fmt = Format::new().set_num_format(FACTOR_FMT);
    let label_fmt = Format::new().set_bold().set_align(FormatAlign::Right);

    // Footer rows (section rollups) are bold + filled AND carry a number format —
    // `section_footer_fmt` alone only supplies the fill, so numeric footer cells need
    // their own combined format or they'd render as unformatted numbers.
    let money_footer_fmt = money_fmt.clone().set_bold().set_pattern(FormatPattern::Solid).set_background_color(Color::RGB(0xFFF2CC));
    let factor_footer_fmt = factor_fmt.clone().set_bold().set_pattern(FormatPattern::Solid).set_background_color(Color::RGB(0xFFF2CC));

    // Header row.
    for (i, c) in cols.iter().enumerate() {
        worksheet.write_string_with_format(0, i as u16, c.header, &header_fmt)?;
        worksheet.set_column_width(i as u16, c.width)?;
    }
    worksheet.set_freeze_panes(1, 0)?;

    // Data rows. Excel rows are 1-indexed for formula text; `write_*` takes 0-indexed
    // row/col, so `excel_row = data_row_num0 + 1` throughout (row 0 is the header).
    let mut line_item_excel_rows: Vec<u32> = Vec::new();
    for (i, row) in payload.rows.iter().enumerate() {
        let excel_row0 = (i + 1) as u32; // 0-indexed for write_* calls
        let is_header = row.row_kind.as_deref() == Some("header");
        let is_footer = row.row_kind.as_deref() == Some("footer");
        let row_fmt = match row.row_kind.as_deref() {
            Some("header") => Some(&section_header_fmt),
            Some("footer") => Some(&section_footer_fmt),
            _ => None,
        };
        if row.row_kind.is_none() {
            line_item_excel_rows.push(excel_row0 + 1); // 1-indexed Excel row, for formula text
        }

        let money_value_fmt = if is_footer { &money_footer_fmt } else { &money_fmt };
        let factor_value_fmt = if is_footer { &factor_footer_fmt } else { &factor_fmt };

        // A header/footer row's cost-code cells need the same boxed left/right border
        // as regular input cells or the vertical lines visibly break at that row.
        let cost_code_fill = if is_header { Some(0xD9D9D9) } else if is_footer { Some(0xFFF2CC) } else { None };

        for (ci, c) in cols.iter().enumerate() {
            let col0 = ci as u16;
            match c.kind {
                ColKind::SectionCode => write_text(worksheet, excel_row0, col0, &row.section_code, row_fmt)?,
                ColKind::SectionDesc => write_text(worksheet, excel_row0, col0, &row.section_desc, row_fmt)?,
                ColKind::Code => write_text(worksheet, excel_row0, col0, &row.code, row_fmt)?,
                ColKind::Desc => write_text(worksheet, excel_row0, col0, &row.desc, row_fmt)?,
                ColKind::Unit => write_text(worksheet, excel_row0, col0, &row.unit, row_fmt)?,
                ColKind::Qty => write_num(worksheet, excel_row0, col0, row.qty, money_value_fmt, row_fmt)?,
                ColKind::Rate => write_num(worksheet, excel_row0, col0, row.rate, money_value_fmt, row_fmt)?,
                ColKind::Subtotal => write_num(worksheet, excel_row0, col0, row.subtotal, money_value_fmt, row_fmt)?,
                ColKind::Factor => write_num(worksheet, excel_row0, col0, row.factor, factor_value_fmt, row_fmt)?,
                ColKind::Total => write_num(worksheet, excel_row0, col0, row.total, money_value_fmt, row_fmt)?,
                ColKind::Lab => write_num(worksheet, excel_row0, col0, row.lab, money_value_fmt, row_fmt)?,
                ColKind::LabTotal => write_num(worksheet, excel_row0, col0, row.lab_total, money_value_fmt, row_fmt)?,
                ColKind::Mat => write_num(worksheet, excel_row0, col0, row.mat, money_value_fmt, row_fmt)?,
                ColKind::MatTotal => write_num(worksheet, excel_row0, col0, row.mat_total, money_value_fmt, row_fmt)?,
                ColKind::Sub => write_num(worksheet, excel_row0, col0, row.sub, money_value_fmt, row_fmt)?,
                ColKind::SubTotal => write_num(worksheet, excel_row0, col0, row.sub_total, money_value_fmt, row_fmt)?,
                ColKind::Sum => write_num(worksheet, excel_row0, col0, row.sum, money_value_fmt, row_fmt)?,
                ColKind::SumTotal => write_num(worksheet, excel_row0, col0, row.sum_total, money_value_fmt, row_fmt)?,
                // Cost-code columns are only ever populated by per-row formulas below,
                // and only for real line items — header/footer rows just need the
                // boxed border to carry through so it doesn't visibly break there.
                ColKind::CostCodeLab | ColKind::CostCodeMat | ColKind::CostCodeSub | ColKind::CostCodeSum => {
                    if row_fmt.is_some() {
                        let fmt = box_fmt(true, cost_code_fill, true, false);
                        worksheet.write_blank(excel_row0, col0, &fmt)?;
                    }
                }
                ColKind::TotalLab | ColKind::HoursTotal | ColKind::TotalMat | ColKind::TotalSub | ColKind::TotalSum => {
                    if row_fmt.is_some() {
                        let fmt = box_fmt(false, cost_code_fill, false, true);
                        worksheet.write_blank(excel_row0, col0, &fmt)?;
                    }
                }
            }
        }
    }

    if payload.include_cost_codes && !line_item_excel_rows.is_empty() {
        write_cost_code_columns(worksheet, &cols, payload, &line_item_excel_rows, &money_fmt, &label_fmt)?;
    }

    Ok(workbook)
}

/// Builds the "boxed input area" cell format shared by the cost-code columns' plain
/// rows and header/footer rows — a grey/filled cell with a thick divider border:
/// left+right for the code-entry column, right-only for its neighbouring formula
/// column(s), applied to every row (including header/footer) so the vertical lines
/// run continuously with no gaps.
fn box_fmt(is_code_col: bool, fill: Option<u32>, bold_blue: bool, money: bool) -> Format {
    let mut fmt = Format::new();
    if let Some(color) = fill {
        fmt = fmt.set_pattern(FormatPattern::Solid).set_background_color(Color::RGB(color));
    }
    fmt = if is_code_col {
        fmt.set_border_left(FormatBorder::Thick).set_border_right(FormatBorder::Thick)
    } else {
        fmt.set_border_right(FormatBorder::Thick)
    };
    if bold_blue { fmt = fmt.set_bold().set_font_color(Color::RGB(0x0000FF)); }
    if money { fmt = fmt.set_num_format(MONEY_FMT); }
    fmt
}

fn write_text(
    ws: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    value: &str,
    fmt: Option<&Format>,
) -> Result<(), XlsxError> {
    match fmt {
        Some(f) => ws.write_string_with_format(row, col, value, f)?,
        None => ws.write_string(row, col, value)?,
    };
    Ok(())
}

/// `value_fmt` must already combine the number format with any row-level bold/fill
/// (see `money_value_fmt`/`factor_value_fmt` in `build_workbook`); `blank_fmt` is only
/// used to preserve a header/footer row's fill on cells left empty.
fn write_num(
    ws: &mut rust_xlsxwriter::Worksheet,
    row: u32,
    col: u16,
    value: Option<f64>,
    value_fmt: &Format,
    blank_fmt: Option<&Format>,
) -> Result<(), XlsxError> {
    let Some(v) = value else {
        if let Some(f) = blank_fmt {
            ws.write_blank(row, col, f)?;
        }
        return Ok(());
    };
    ws.write_number_with_format(row, col, v, value_fmt)?;
    Ok(())
}

/// The four category code columns, in the fixed order the blueprint's `m` (max
/// distinct-code count) computation walks them: Labour, Mat, Sub, Sum.
struct CostCodeCols {
    lab: u16,
    total_lab: u16,
    hours_total: u16,
    mat: u16,
    total_mat: u16,
    sub: u16,
    total_sub: u16,
    sum: u16,
    total_sum: u16,
}

fn write_cost_code_columns(
    ws: &mut rust_xlsxwriter::Worksheet,
    cols: &[ColSpec],
    payload: &ExcelExportPayload,
    line_item_rows: &[u32],
    money_fmt: &Format,
    label_fmt: &Format,
) -> Result<(), XlsxError> {
    let c = CostCodeCols {
        lab: col_index(cols, ColKind::CostCodeLab).expect("cost code columns present"),
        total_lab: col_index(cols, ColKind::TotalLab).unwrap(),
        hours_total: col_index(cols, ColKind::HoursTotal).unwrap(),
        mat: col_index(cols, ColKind::CostCodeMat).unwrap(),
        total_mat: col_index(cols, ColKind::TotalMat).unwrap(),
        sub: col_index(cols, ColKind::CostCodeSub).unwrap(),
        total_sub: col_index(cols, ColKind::TotalSub).unwrap(),
        sum: col_index(cols, ColKind::CostCodeSum).unwrap(),
        total_sum: col_index(cols, ColKind::TotalSum).unwrap(),
    };
    // "Lab - Total" already holds this row's total labour hours (rate-build-up hours
    // per unit × take-off quantity) — HOURS - Total just pulls it through when a
    // labour code is entered, and it's also where the blended $/hr rate is anchored.
    let lab_field_col = col_index(cols, ColKind::Lab).unwrap();
    let lab_total_col = col_index(cols, ColKind::LabTotal).unwrap();
    let mat_total_col = col_index(cols, ColKind::MatTotal).unwrap();
    let sub_total_col = col_index(cols, ColKind::SubTotal).unwrap();
    let sum_total_col = col_index(cols, ColKind::SumTotal).unwrap();

    // 1-indexed row of the very last row written (row 1 is the header) — footer rows
    // from Sections+Items bracketing sit immediately after the last line item with no
    // gap, so the rate cell and summary spill must clear the *whole sheet*, not just
    // the last line item, or they'd silently overwrite a section's footer values.
    let sheet_last_row1 = payload.rows.len() as u32 + 1;
    let rate_row1 = sheet_last_row1 + 2; // 1-indexed Excel row

    // Per-row formulas, line items only.
    let code_fmt = box_fmt(true, Some(0xD9D9D9), true, false);
    let value_fmt = box_fmt(false, Some(0xD9D9D9), false, true);
    for &r in line_item_rows {
        let m = column_number_to_name(c.lab);
        let l = column_number_to_name(lab_total_col);
        let rt = column_number_to_name(c.mat);
        let q = column_number_to_name(mat_total_col);
        let v = column_number_to_name(c.sub);
        let u = column_number_to_name(sub_total_col);
        let z = column_number_to_name(c.sum);
        let y = column_number_to_name(sum_total_col);

        let row0 = r - 1; // back to 0-indexed for write_*

        // Blank, styled entry cells — grey box with a thick border, matching the
        // blueprint — for the codes the estimator types in by hand.
        ws.write_blank(row0, c.lab, &code_fmt)?;
        ws.write_blank(row0, c.mat, &code_fmt)?;
        ws.write_blank(row0, c.sub, &code_fmt)?;
        ws.write_blank(row0, c.sum, &code_fmt)?;

        ws.write_formula_with_format(row0, c.hours_total, format!("=IF({m}{r}>0,{l}{r},\"-\")").as_str(), &value_fmt)?;
        // Rate cell is filled in after this loop, at a fixed row two below the data —
        // referenced here even though it's written later since formula text doesn't
        // need the target cell to exist yet.
        ws.write_formula_with_format(
            row0,
            c.total_lab,
            format!(
                "=IFERROR({hc}{r}*${rate_col}${rate_row},\"-\")",
                hc = column_number_to_name(c.hours_total),
                r = r,
                rate_col = l,
                rate_row = rate_row1,
            )
            .as_str(),
            &value_fmt,
        )?;
        ws.write_formula_with_format(row0, c.total_mat, format!("=IF({rt}{r}>0,{q}{r},\"-\")").as_str(), &value_fmt)?;
        ws.write_formula_with_format(row0, c.total_sub, format!("=IF({v}{r}>0,{u}{r},\"-\")").as_str(), &value_fmt)?;
        ws.write_formula_with_format(row0, c.total_sum, format!("=IF({z}{r}>0,{y}{r},\"-\")").as_str(), &value_fmt)?;
    }

    // Blended labour rate — a literal value the estimator can override, referenced
    // absolutely by every TOTAL Labour formula above.
    let rate_row0 = rate_row1 - 1;
    ws.write_string_with_format(rate_row0, lab_field_col, "Labour Rate", label_fmt)?;
    ws.write_number_with_format(rate_row0, lab_total_col, payload.lab_rate.unwrap_or(0.0), money_fmt)?;

    // Group-by-cost-code summary block, one row after the *whole sheet's* last row
    // (not just the last line item — see the `sheet_last_row1` comment above), in
    // each of the 4 code columns plus their value column(s). All nine formulas
    // recompute the same "m" (max distinct-code count across all 4 categories) so
    // their spills stay equal height and every TOTAL row lands on the same line.
    let spill_row0 = sheet_last_row1; // 0-indexed row immediately after the last 1-indexed sheet row
    // Cost-code columns are blank on header/footer rows, so distinct-code discovery
    // only needs to scan between the first and last *line item*, not the whole sheet.
    let first_row1 = *line_item_rows.iter().min().unwrap();
    let last_row1 = *line_item_rows.iter().max().unwrap();

    let code_cols = [c.lab, c.mat, c.sub, c.sum];
    let m_clause = build_m_clause(&code_cols, first_row1, last_row1);

    write_list_formula(ws, spill_row0, c.lab, &m_clause, c.lab, first_row1, last_row1)?;
    write_value_formula(ws, spill_row0, c.total_lab, &m_clause, c.lab, c.total_lab, first_row1, last_row1, money_fmt)?;
    write_value_formula(ws, spill_row0, c.hours_total, &m_clause, c.lab, c.hours_total, first_row1, last_row1, money_fmt)?;

    write_list_formula(ws, spill_row0, c.mat, &m_clause, c.mat, first_row1, last_row1)?;
    write_value_formula(ws, spill_row0, c.total_mat, &m_clause, c.mat, c.total_mat, first_row1, last_row1, money_fmt)?;

    write_list_formula(ws, spill_row0, c.sub, &m_clause, c.sub, first_row1, last_row1)?;
    write_value_formula(ws, spill_row0, c.total_sub, &m_clause, c.sub, c.total_sub, first_row1, last_row1, money_fmt)?;

    write_list_formula(ws, spill_row0, c.sum, &m_clause, c.sum, first_row1, last_row1)?;
    write_value_formula(ws, spill_row0, c.total_sum, &m_clause, c.sum, c.total_sum, first_row1, last_row1, money_fmt)?;

    // Conditional formatting for the summary block, since its real height isn't known
    // until Excel recalculates the spill — no fill; this is purely a border/font/
    // number-format continuation of the input area's boxed look for whichever rows
    // actually end up populated. Code and value columns are ruled separately (one CF
    // range only ever carries one format) so the code column keeps its left+right
    // border while the value column(s) get a right-only border + money format. Text
    // stays plain black here — the #0000FF blue is reserved for the D9D9D9-filled
    // input area, where it signals a cell the estimator can type into; the summary
    // block is read-only formula output. The TOTAL row gets its own rule with a
    // border on all four sides — registered *first* so it wins priority over the
    // plain "populated" rule on the same row, giving that row a fully closed box.
    let cf_last_row0 = spill_row0 + SPILL_CF_ROWS;
    let spill_row1 = spill_row0 + 1; // 1-indexed, for the TOTAL-row formula text
    let cf_code_fmt = Format::new().set_border_left(FormatBorder::Thick).set_border_right(FormatBorder::Thick);
    let cf_code_total_fmt = Format::new().set_border(FormatBorder::Thick).set_bold();
    let cf_value_fmt = Format::new().set_border_right(FormatBorder::Thick).set_num_format(MONEY_FMT);
    let cf_value_total_fmt = Format::new().set_border(FormatBorder::Thick).set_bold().set_num_format(MONEY_FMT);

    // All four categories share one "m" (max distinct-code count), so a category
    // with fewer codes than the longest one gets EXPAND-padded with "" on its own
    // trailing rows up to the shared TOTAL row — a per-column "is this cell blank"
    // check misses those padded rows entirely, breaking the border partway down.
    // Checking all four code columns together catches them: some column always has
    // real content (or "TOTAL") on every row through the shared TOTAL row, and none
    // do on any row after it.
    let populated_rule = format!(
        "=OR(${lab}{r}<>\"\",${mat}{r}<>\"\",${sub}{r}<>\"\",${sum}{r}<>\"\")",
        lab = column_number_to_name(c.lab),
        mat = column_number_to_name(c.mat),
        sub = column_number_to_name(c.sub),
        sum = column_number_to_name(c.sum),
        r = spill_row1,
    );

    for &(code_col, value_first, value_last) in &[
        (c.lab, c.total_lab, c.hours_total),
        (c.mat, c.total_mat, c.total_mat),
        (c.sub, c.total_sub, c.total_sub),
        (c.sum, c.total_sum, c.total_sum),
    ] {
        let code_letter = column_number_to_name(code_col);
        let total_rule = format!("=${code_letter}{spill_row1}=\"TOTAL\"");

        ws.add_conditional_format(
            spill_row0, code_col, cf_last_row0, code_col,
            &ConditionalFormatFormula::new().set_rule(total_rule.as_str()).set_format(cf_code_total_fmt.clone()),
        )?;
        ws.add_conditional_format(
            spill_row0, code_col, cf_last_row0, code_col,
            &ConditionalFormatFormula::new().set_rule(populated_rule.as_str()).set_format(cf_code_fmt.clone()),
        )?;

        ws.add_conditional_format(
            spill_row0, value_first, cf_last_row0, value_last,
            &ConditionalFormatFormula::new().set_rule(total_rule.as_str()).set_format(cf_value_total_fmt.clone()),
        )?;
        ws.add_conditional_format(
            spill_row0, value_first, cf_last_row0, value_last,
            &ConditionalFormatFormula::new().set_rule(populated_rule.as_str()).set_format(cf_value_fmt.clone()),
        )?;
    }

    Ok(())
}

/// The `LET(_xlpm.m, MAX(1, <4 distinct-code-count clauses>), ...)` prefix shared by
/// all nine summary formulas — ported from the blueprint workbook's raw XML, with the
/// row range re-pointed to this export's actual data extent.
fn build_m_clause(code_cols: &[u16; 4], first_row: u32, last_row: u32) -> String {
    let mut parts = Vec::with_capacity(4);
    for &col in code_cols {
        let letter = column_number_to_name(col);
        parts.push(format!(
            "LET(_xlpm.f,FILTER({l}{s}:{l}{e},{l}{s}:{l}{e}<>\"\",\"\"),IF(INDEX(_xlpm.f,1)=\"\",0,ROWS(UNIQUE(_xlpm.f))))",
            l = letter,
            s = first_row,
            e = last_row,
        ));
    }
    format!("LET(_xlpm.m,MAX(1, {}), ", parts.join(","))
}

/// Writes the "list of codes, ending in TOTAL" formula into a category's code column
/// (e.g. `Cost Code - Mat`).
fn write_list_formula(
    ws: &mut rust_xlsxwriter::Worksheet,
    row0: u32,
    col: u16,
    m_clause: &str,
    code_col: u16,
    first_row: u32,
    last_row: u32,
) -> Result<(), XlsxError> {
    let code = column_number_to_name(code_col);
    let formula = format!(
        "={m}_xlpm.u, IFERROR(UNIQUE(FILTER({code}{s}:{code}{e},{code}{s}:{code}{e}<>\"\")),\"\"), VSTACK(EXPAND(_xlpm.u,_xlpm.m,1,\"\"), \"TOTAL\"))",
        m = m_clause,
        code = code,
        s = first_row,
        e = last_row,
    );
    ws.write_dynamic_formula(row0, col, formula.as_str())?;
    Ok(())
}

/// Writes the "value summed per distinct code, ending in a grand total" formula into
/// a category's value column (e.g. `TOTAL Mat`, or `HOURS - Total` for Labour).
#[allow(clippy::too_many_arguments)]
fn write_value_formula(
    ws: &mut rust_xlsxwriter::Worksheet,
    row0: u32,
    col: u16,
    m_clause: &str,
    code_col: u16,
    value_col: u16,
    first_row: u32,
    last_row: u32,
    value_fmt: &Format,
) -> Result<(), XlsxError> {
    let code = column_number_to_name(code_col);
    let val = column_number_to_name(value_col);
    let formula = format!(
        "={m}_xlpm.u, IFERROR(UNIQUE(FILTER({code}{s}:{code}{e},{code}{s}:{code}{e}<>\"\")),\"\"), \
         _xlpm.v, IF(INDEX(_xlpm.u,1)=\"\",\"\",BYROW(_xlpm.u,LAMBDA(_xlpm.x,SUM(FILTER({val}{s}:{val}{e},{code}{s}:{code}{e}=_xlpm.x,0))))), \
         VSTACK(EXPAND(_xlpm.v,_xlpm.m,1,\"\"), SUM({val}{s}:{val}{e})))",
        m = m_clause,
        code = code,
        val = val,
        s = first_row,
        e = last_row,
    );
    ws.write_dynamic_formula_with_format(row0, col, formula.as_str(), value_fmt)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(code: &str, desc: &str, qty: f64) -> ExportRow {
        ExportRow {
            row_kind: None,
            section_code: "S1".into(),
            section_desc: "Section One".into(),
            code: code.into(),
            desc: desc.into(),
            qty: Some(qty),
            unit: "m2".into(),
            rate: Some(12.5),
            subtotal: Some(qty * 12.5),
            factor: Some(1.0),
            total: Some(qty * 12.5),
            lab: Some(0.4),
            lab_total: Some(qty * 0.4),
            mat: Some(3.0),
            mat_total: Some(qty * 3.0),
            sub: Some(1.0),
            sub_total: Some(qty * 1.0),
            sum: Some(0.5),
            sum_total: Some(qty * 0.5),
        }
    }

    /// Builds a representative workbook (Sections+Items, cost codes on) and saves it
    /// to the scratchpad so its raw XML can be diffed against the blueprint file's
    /// structure by hand — `cargo test -p desktop excel_export -- --nocapture`.
    #[test]
    fn writes_cost_code_export_for_manual_xml_inspection() {
        let payload = ExcelExportPayload {
            include_section_cols: true,
            include_cost_codes: true,
            lab_rate: Some(70.0),
            rows: vec![
                ExportRow { row_kind: Some("header".into()), ..row("", "", 0.0) },
                row("C101", "Item one", 10.0),
                row("C102", "Item two", 20.0),
                row("C101", "Item three", 5.0),
                ExportRow {
                    row_kind: Some("footer".into()),
                    section_desc: "Total of Section One".into(),
                    subtotal: Some(437.5),
                    factor: Some(1.0),
                    total: Some(437.5),
                    ..row("", "", 0.0)
                },
            ],
        };

        let mut workbook = build_workbook(&payload).expect("build_workbook should succeed");
        let out = std::env::var("COST_CODE_TEST_OUTPUT")
            .unwrap_or_else(|_| "cost_code_export_test.xlsx".to_string());
        workbook.save(&out).expect("save should succeed");
    }
}
